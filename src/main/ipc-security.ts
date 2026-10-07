export function validateSettingsSender(event: { sender: { id: number }; senderFrame: { url: string; parent: unknown } | null },
  settings: { id: number; url: string } | undefined): void {
  if (!settings || event.sender.id !== settings.id || !event.senderFrame || event.senderFrame.parent || event.senderFrame.url !== settings.url)
    throw new Error('IPC caller is not the trusted settings main frame');
}
