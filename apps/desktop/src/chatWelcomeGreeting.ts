export function chatWelcomeGreeting(name: string, now = new Date()): string {
  const firstName = name.trim().split(/\s+/)[0]?.slice(0, 80);
  if (!firstName) return "What can I help you with?";

  const hour = now.getHours();
  if (hour < 5) return `What’s on your mind, ${firstName}?`;
  if (hour < 12) return `Good morning, ${firstName}!`;
  if (hour < 17) return `Good afternoon, ${firstName}!`;
  if (hour < 22) return `Good evening, ${firstName}!`;
  return `How can I help, ${firstName}?`;
}
