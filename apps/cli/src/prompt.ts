import { emitKeypressEvents } from "node:readline";

export async function readHidden(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stderr.isTTY || typeof process.stdin.setRawMode !== "function") {
    throw new Error("Interactive token input requires a TTY. Pipe the token and use --token-stdin instead.");
  }

  process.stderr.write(prompt);
  emitKeypressEvents(process.stdin);
  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();

  return new Promise<string>((resolve, reject) => {
    let secret = "";
    const finish = (error?: Error): void => {
      process.stdin.off("keypress", onKeypress);
      process.stdin.setRawMode(wasRaw);
      process.stdin.pause();
      process.stderr.write("\n");
      if (error) reject(error);
      else resolve(secret);
    };
    const onKeypress = (character: string | undefined, key: { name?: string; ctrl?: boolean }): void => {
      if (key.ctrl && key.name === "c") {
        finish(new Error("Login cancelled."));
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        finish();
        return;
      }
      if (key.name === "backspace") {
        secret = secret.slice(0, -1);
        return;
      }
      if (character && !key.ctrl && !character.includes("\u001b")) secret += character;
    };
    process.stdin.on("keypress", onKeypress);
  });
}

export async function readTokenFromStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > 16 * 1024) throw new Error("Token input is too large.");
    chunks.push(buffer);
  }
  const token = Buffer.concat(chunks).toString("utf8").trim();
  if (!token) throw new Error("No token was provided on stdin.");
  return token;
}
