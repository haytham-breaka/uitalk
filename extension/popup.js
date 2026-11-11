// Lists paired sites and lets the user remove one, which also drops Chrome's
// permission for it.

function render() {
  chrome.runtime.sendMessage({ type: "list" }, (reply) => {
    const list = document.getElementById("list");
    list.replaceChildren();
    const pairings = reply?.ok ? reply.pairings : [];
    document.getElementById("empty").hidden = pairings.length > 0;
    for (const p of pairings) {
      const li = document.createElement("li");
      const site = document.createElement("a");
      site.href = p.site;
      site.target = "_blank";
      site.textContent = p.site;
      const project = document.createElement("div");
      project.className = "muted";
      project.textContent = `${p.project} · :${p.port}`;
      const remove = document.createElement("button");
      remove.className = "quiet";
      remove.textContent = "Remove";
      remove.addEventListener("click", () => chrome.runtime.sendMessage({ type: "unpair", site: p.site }, render));
      li.append(site, project, remove);
      list.append(li);
    }
  });
}

render();
