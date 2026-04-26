import { readFileSync } from "fs";
import { createDataItemSigner, message, result } from "@permaweb/aoconnect";

const DEFAULT_WALLET = "/home/mk19/.aos.json";

export async function loadSigner(walletPath = process.env.AR_WALLET || DEFAULT_WALLET) {
  const wallet = JSON.parse(readFileSync(walletPath, "utf8"));
  return createDataItemSigner(wallet);
}

export async function sendAoJson({ processId, action, data, tags = [], signer }) {
  if (!processId) throw new Error("processId is required");
  const msgId = await message({
    process: processId,
    tags: [{ name: "Action", value: action }, ...tags],
    data: JSON.stringify(data),
    signer
  });
  return result({ process: processId, message: msgId });
}

export function latestMessageData(res) {
  const message = res?.Messages?.[res.Messages.length - 1];
  if (!message?.Data) return null;
  return JSON.parse(message.Data);
}
