//! The bounded tail of one server's output.
//!
//! A dev server can print a stack trace per frame, and a bundler can print a
//! single line that is megabytes of base64. Keeping all of that would trade a
//! broken page for a broken app, so the buffer is a ring with a fixed line
//! count and a fixed line length, oldest dropped first.
//!
//! What makes a bounded buffer safe to read is the sequence number. It counts
//! every line the server ever wrote — including the ones already evicted — so
//! a reader resuming from `since` can tell "nothing new" apart from "you
//! missed four hundred lines", instead of silently skipping them or reading
//! the same tail twice.

use std::{collections::VecDeque, io::BufRead};

use serde::Serialize;

/// Lines kept per server: several screens of scrollback, and a couple of
/// megabytes at the very worst once `MAX_LINE_CHARS` is applied.
pub const DEFAULT_CAPACITY: usize = 2_000;
/// Longest line kept. The tail of a minified bundle or an inlined source map
/// is never the part anyone reads, and keeping it would defeat the ring.
pub const MAX_LINE_CHARS: usize = 1_000;
/// Byte ceiling used while reading, before the text is decoded. Four bytes per
/// character is the widest UTF-8 sequence, so nothing legible is lost here.
pub const MAX_LINE_BYTES: usize = 4 * MAX_LINE_CHARS;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Stream {
    Stdout,
    Stderr,
    /// Written by this module rather than by the child: the command line, a
    /// stop, an exit code. Marked so the UI can render it as ours.
    System,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogLine {
    pub seq: u64,
    pub stream: Stream,
    pub text: String,
}

#[derive(Debug)]
pub struct LogBuffer {
    capacity: usize,
    next_seq: u64,
    dropped: u64,
    lines: VecDeque<LogLine>,
}

impl Default for LogBuffer {
    fn default() -> Self {
        Self::new(DEFAULT_CAPACITY)
    }
}

impl LogBuffer {
    pub fn new(capacity: usize) -> Self {
        Self {
            // A zero-capacity ring would drop every line as it arrived and
            // report sequence numbers for text nobody can ever read.
            capacity: capacity.max(1),
            next_seq: 0,
            dropped: 0,
            lines: VecDeque::new(),
        }
    }

    /// Append one line and return the sequence number it was given.
    pub fn push(&mut self, stream: Stream, text: &str) -> u64 {
        let seq = self.next_seq;
        self.next_seq += 1;
        let trimmed = text.trim_end_matches(['\n', '\r']);
        let mut kept = String::new();
        let mut characters = trimmed.chars();
        kept.extend(characters.by_ref().take(MAX_LINE_CHARS));
        if characters.next().is_some() {
            kept.push('…');
        }
        if self.lines.len() >= self.capacity {
            self.lines.pop_front();
            self.dropped += 1;
        }
        self.lines.push_back(LogLine {
            seq,
            stream,
            text: kept,
        });
        seq
    }

    /// Every retained line numbered `since` or later, oldest first.
    pub fn since(&self, since: u64) -> Vec<LogLine> {
        self.lines
            .iter()
            .filter(|line| line.seq >= since)
            .cloned()
            .collect()
    }

    /// The number the next line will carry. A reader that has consumed
    /// everything asks again with exactly this value.
    pub fn next_seq(&self) -> u64 {
        self.next_seq
    }

    /// How many lines the ring has evicted over its lifetime. Surfaced to the
    /// reader so a gap can be shown as a gap rather than passing for silence.
    pub fn dropped(&self) -> u64 {
        self.dropped
    }
}

/// Read one line, never buffering more than `max` bytes of it.
///
/// `BufRead::read_until` would allocate the whole line first, which is the one
/// thing a log reader facing hostile output must not do: a child that prints a
/// gigabyte without a newline would take the app down with it. An over-long
/// line is handed back in `max`-sized pieces instead, and the caller records
/// each piece as its own entry. Returns `false` only at end of input.
pub fn read_bounded_line<R: BufRead>(
    reader: &mut R,
    out: &mut Vec<u8>,
    max: usize,
) -> std::io::Result<bool> {
    // A ceiling of zero would consume nothing and loop forever.
    let max = max.max(1);
    out.clear();
    let mut saw_bytes = false;
    loop {
        let available = match reader.fill_buf() {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        };
        if available.is_empty() {
            return Ok(saw_bytes);
        }
        saw_bytes = true;
        let newline = available.iter().position(|byte| *byte == b'\n');
        let room = max.saturating_sub(out.len());
        // Every arm either consumes at least one byte or returns, so an
        // endless line can never spin this loop without making progress.
        match newline {
            Some(at) if at <= room => {
                out.extend_from_slice(&available[..at]);
                reader.consume(at + 1);
                return Ok(true);
            }
            _ => {
                let take = available.len().min(room);
                out.extend_from_slice(&available[..take]);
                reader.consume(take);
                if out.len() >= max {
                    return Ok(true);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn sequence_numbers_are_monotonic_across_evictions() {
        let mut buffer = LogBuffer::new(3);
        for index in 0..10 {
            let seq = buffer.push(Stream::Stdout, &format!("line {index}"));
            assert_eq!(seq, index, "each push takes the next number");
        }
        assert_eq!(buffer.next_seq(), 10);
        let retained: Vec<u64> = buffer.since(0).iter().map(|line| line.seq).collect();
        assert_eq!(retained, [7, 8, 9], "numbers keep climbing past the ring");
    }

    #[test]
    fn the_buffer_bounds_at_capacity_and_drops_oldest() {
        let mut buffer = LogBuffer::new(4);
        for index in 0..100 {
            buffer.push(Stream::Stdout, &format!("line {index}"));
        }
        let retained = buffer.since(0);
        assert_eq!(retained.len(), 4, "the ring never grows past its capacity");
        assert_eq!(buffer.dropped(), 96);
        assert_eq!(retained.first().map(|line| line.seq), Some(96));
        assert_eq!(
            retained.first().map(|line| line.text.clone()),
            Some("line 96".into())
        );
        assert_eq!(
            retained.last().map(|line| line.text.clone()),
            Some("line 99".into())
        );
    }

    #[test]
    fn a_reader_resuming_from_since_sees_every_line_exactly_once() {
        let mut buffer = LogBuffer::new(DEFAULT_CAPACITY);
        let mut seen: Vec<String> = Vec::new();
        let mut cursor = 0;
        // Three rounds of writes with a read in between, the way a UI polls.
        for round in 0..3 {
            for index in 0..7 {
                buffer.push(Stream::Stdout, &format!("r{round}-{index}"));
            }
            let batch = buffer.since(cursor);
            for line in &batch {
                assert_eq!(line.seq, cursor, "no gaps and no repeats");
                cursor += 1;
                seen.push(line.text.clone());
            }
            assert!(buffer.since(cursor).is_empty(), "a caught-up reader sees nothing");
        }
        assert_eq!(seen.len(), 21);
        assert_eq!(seen.first().map(String::as_str), Some("r0-0"));
        assert_eq!(seen.last().map(String::as_str), Some("r2-6"));
        assert_eq!(cursor, buffer.next_seq());
    }

    #[test]
    fn one_enormous_line_cannot_grow_the_buffer() {
        let mut buffer = LogBuffer::new(8);
        buffer.push(Stream::Stderr, &"x".repeat(500_000));
        let stored = &buffer.since(0)[0].text;
        assert_eq!(stored.chars().count(), MAX_LINE_CHARS + 1, "truncated, with a marker");
        assert!(stored.ends_with('…'));
    }

    #[test]
    fn trailing_carriage_returns_are_not_kept() {
        let mut buffer = LogBuffer::default();
        buffer.push(Stream::Stdout, "ready in 412 ms\r\n");
        assert_eq!(buffer.since(0)[0].text, "ready in 412 ms");
    }

    #[test]
    fn bounded_reads_split_lines_on_newlines() {
        let mut reader = Cursor::new(b"first\r\nsecond\n\nthird".to_vec());
        let mut out = Vec::new();
        let mut lines = Vec::new();
        while read_bounded_line(&mut reader, &mut out, MAX_LINE_BYTES).unwrap_or(false) {
            lines.push(String::from_utf8_lossy(&out).into_owned());
        }
        assert_eq!(lines, ["first\r", "second", "", "third"]);
    }

    #[test]
    fn bounded_reads_hand_back_an_endless_line_in_pieces() {
        let mut reader = Cursor::new(vec![b'z'; 25]);
        let mut out = Vec::new();
        let mut pieces = 0;
        while read_bounded_line(&mut reader, &mut out, 10).unwrap_or(false) {
            assert!(out.len() <= 10, "no read ever exceeds the ceiling");
            pieces += 1;
            assert!(pieces < 10, "the reader must make progress, not spin");
        }
        assert_eq!(pieces, 3, "25 bytes at 10 per piece");
    }
}
