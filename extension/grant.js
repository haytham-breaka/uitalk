// The confirmation step. Chrome only grants a host permission in response to a click
// on the extension's own page, which is why pairing ends here rather than on the
// bridge's page.

const id = location.hash.slice(1);
const $ = (s) => document.getElementById(s);
const status = (text) => { $("status").textContent = text; };

chrome.runtime.sendMessage({ type: "get-offer", id }, (reply) => {
  if (!reply?.ok) return status(reply?.error ?? "Could not read this pairing.");
  const { offer, paired } = reply;
  $("site").textContent = offer.site;
  $("project").textContent = offer.project;
  if (paired) status(`${offer.site} is already paired; allowing again points it at this session.`);
  $("offer").hidden = false;

  $("allow").addEventListener("click", async () => {
    let granted = false;
    try {
      granted = await chrome.permissions.request({ origins: [`${offer.site}/*`] });
    } catch (err) {
      return status(`Chrome refused: ${err.message}`);
    }
    if (!granted) return status("Not paired: Chrome's permission was declined.");
    chrome.runtime.sendMessage({ type: "accept-offer", id }, (done) => {
      if (!done?.ok) return status(done?.error ?? "Could not save the pairing.");
      location.replace(done.site);
    });
  });
  $("cancel").addEventListener("click", () => {
    $("offer").hidden = true;
    status("Cancelled. Nothing was paired; you can close this tab.");
  });
});
