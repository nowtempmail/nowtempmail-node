/**
 * Wait for mail carrying an attachment, then save it without trusting it.
 *
 *   export NTM_API_KEY="ntm_test_..."
 *   npx tsx examples/attachment-download.ts
 *
 * `attachment.filename` is SENDER-CONTROLLED. So is the content. Whoever sent
 * the mail chose both, and nothing on the way here sanitised them for you. A
 * filename can be `../../.ssh/authorized_keys`, `C:\Windows\System32\x.dll`, or
 * 300 characters of Unicode that renders right-to-left. Use it for display; use
 * `attachment.id` (the attachment's index, as a string) for the path you write.
 *
 * This is also the only endpoint that returns bytes rather than JSON.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { NowTempMail, NowTempMailError, type Attachment } from "nowtempmail";

const OUT_DIR = resolve("./downloads");

/** Extensions we are willing to give a file on disk. Anything else gets .bin. */
const SAFE_EXTENSIONS: Record<string, string> = {
  "application/pdf": ".pdf",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "text/csv": ".csv",
  "text/plain": ".txt",
};

const MAX_BYTES = 5 * 1024 * 1024;

const ntm = new NowTempMail();

/**
 * A path we chose, in a directory we chose. Derived from the attachment index
 * and the content type — not one byte of it comes from the sender.
 */
function safePathFor(attachment: Attachment, contentType: string): string {
  const extension = SAFE_EXTENSIONS[contentType.split(";")[0]!.trim().toLowerCase()] ?? ".bin";
  const path = resolve(join(OUT_DIR, `attachment-${attachment.id}${extension}`));

  // Belt and braces: even a name we built ourselves gets checked for escape.
  if (path !== OUT_DIR && !path.startsWith(OUT_DIR + sep)) {
    throw new Error(`refusing to write outside ${OUT_DIR}`);
  }
  return path;
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });

  const inbox = await ntm.mailboxes.create();
  console.log(`mailbox: ${inbox.address}`);
  console.log("send it something with a file attached...");

  const message = await inbox.waitForMessage({
    // The summary carries attachmentCount, so we can filter on it before
    // spending a request on the full message.
    match: (m) => m.attachmentCount > 0,
    ignoreExisting: true,
    timeoutMs: 180_000,
  });

  console.log(`${message.from}: ${message.subject}`);
  console.log(`${message.attachments.length} attachment(s)`);

  for (const attachment of message.attachments) {
    // Log the sender's filename, do not build a path from it.
    console.log(
      `  [${attachment.id}] claimed name ${JSON.stringify(attachment.filename)}, ` +
        `${attachment.contentType}, ${attachment.size} bytes`,
    );

    if (attachment.size > MAX_BYTES) {
      console.warn(`  skipping: ${attachment.size} bytes exceeds the ${MAX_BYTES} byte cap`);
      continue;
    }

    const { bytes, contentType, filename } = await attachment.download();

    // `contentType` and `filename` on the response are the same sender-supplied
    // values echoed back. Trust neither; the byte count is the only fact here.
    const path = safePathFor(attachment, contentType);
    await writeFile(path, bytes);
    console.log(`  wrote ${bytes.byteLength} bytes to ${path} (sender called it ${filename})`);
  }

  await inbox.delete();
}

main().catch((err: unknown) => {
  if (NowTempMailError.is(err)) {
    if (err.code === "timeout") {
      console.error("no attachment arrived in time");
    } else {
      console.error(err.toLogString());
      console.error(err.message);
    }
  } else {
    console.error(err);
  }
  process.exitCode = 1;
});
