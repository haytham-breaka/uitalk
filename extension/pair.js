// Runs on a bridge's pairing page. Reads the offer the bridge put there and hands
// it to the service worker, which checks it and opens the confirmation page. Nothing
// is paired until the user confirms there.

(() => {
  const block = document.getElementById("uitalk-pairing");
  const status = document.getElementById("uitalk-pair-status");
  const missing = document.getElementById("uitalk-no-extension");
  if (!block) return;
  if (missing) missing.hidden = true;

  let offer;
  try {
    offer = JSON.parse(block.textContent);
  } catch {
    if (status) status.textContent = "This pairing page is malformed.";
    return;
  }
  if (status) status.textContent = "Opening the uitalk extension to confirm…";
  chrome.runtime.sendMessage({ type: "pair-offer", offer }, (reply) => {
    if (chrome.runtime.lastError || !reply?.ok) {
      if (status) status.textContent = `Could not pair: ${reply?.error ?? chrome.runtime.lastError?.message ?? "no reply"}`;
    }
  });
})();
