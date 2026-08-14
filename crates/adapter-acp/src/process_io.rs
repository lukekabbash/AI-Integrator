use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use integrator_core::IntegratorError;
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    sync::{Mutex, broadcast},
};

use super::{
    AcpEvent, AcpPromptOutcome, JsonlFrame, PendingRequest, emit_prompt_finished,
    fail_discarded_response, read_jsonl, route_message,
};

pub(super) fn spawn_stdout_reader(
    stdout: impl AsyncRead + Unpin + Send + 'static,
    pending: Arc<Mutex<HashMap<u64, PendingRequest>>>,
    events: broadcast::Sender<AcpEvent>,
    transport_alive: Arc<AtomicBool>,
) {
    tokio::spawn(async move {
        read_jsonl(stdout, |frame| {
            let pending = Arc::clone(&pending);
            let events = events.clone();
            async move {
                match frame {
                    JsonlFrame::Message(message) => route_message(message, pending, events).await,
                    JsonlFrame::Invalid(bytes) => {
                        fail_discarded_response(&bytes, &pending, &events, "invalid-json").await;
                    }
                    JsonlFrame::TooLarge(head) => {
                        fail_discarded_response(&head, &pending, &events, "message-too-large")
                            .await;
                    }
                }
            }
        })
        .await;
        // Mark the transport dead before waking pending requests. Callers
        // that immediately reconnect must never reuse this exited process.
        transport_alive.store(false, Ordering::Release);
        let mut pending = pending.lock().await;
        for (_, request) in pending.drain() {
            let error = IntegratorError::Unavailable("ACP agent exited".into());
            emit_prompt_finished(
                &events,
                &request,
                AcpPromptOutcome::Error {
                    message: error.to_string(),
                },
            );
            let _ = request.sender.send(Err(error));
        }
        let _ = events.send(AcpEvent::Exited);
    });
}

pub(super) fn spawn_stderr_drain(
    stderr: impl AsyncRead + Unpin + Send + 'static,
    events: broadcast::Sender<AcpEvent>,
) {
    tokio::spawn(async move {
        let mut stderr = stderr;
        let mut buffer = [0_u8; 8192];
        let mut emitted = false;
        loop {
            match stderr.read(&mut buffer).await {
                Ok(0) | Err(_) => break,
                Ok(_) if !emitted => {
                    emitted = true;
                    let _ = events.send(AcpEvent::StderrActivity);
                }
                Ok(_) => {}
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use tokio::sync::oneshot;

    use super::*;

    #[tokio::test]
    async fn stdout_exit_marks_transport_dead_before_failing_pending_requests() {
        let (writer, reader) = tokio::io::duplex(64);
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let (sender, response) = oneshot::channel();
        pending.lock().await.insert(
            1,
            PendingRequest {
                method: "session/new".into(),
                session_id: None,
                sender,
            },
        );
        let (events, mut receiver) = broadcast::channel(4);
        let transport_alive = Arc::new(AtomicBool::new(true));
        spawn_stdout_reader(
            reader,
            Arc::clone(&pending),
            events,
            Arc::clone(&transport_alive),
        );

        drop(writer);
        let result = tokio::time::timeout(std::time::Duration::from_secs(1), response)
            .await
            .expect("pending request settled")
            .expect("reader used sender");

        assert!(
            result.is_err(),
            "exited transport fails the pending request"
        );
        assert!(
            !transport_alive.load(Ordering::Acquire),
            "liveness is cleared before the request wakes"
        );
        assert_eq!(receiver.recv().await.expect("exit event"), AcpEvent::Exited);
    }
}
