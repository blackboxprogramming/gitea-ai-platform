/** Inline dashboard HTML served at /dashboard */
export function dashboardHTML(giteaUrl: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>BlackRoad Platform</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0a0a0a;color:#e0e0e0;font-family:-apple-system,system-ui,sans-serif;min-height:100vh}
.header{background:linear-gradient(135deg,#1a1a2e,#16213e);border-bottom:2px solid #FF1D6C;padding:1.5rem 2rem;display:flex;justify-content:space-between;align-items:center}
.header h1{font-size:1.5rem;background:linear-gradient(90deg,#FF1D6C,#F5A623);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.header .links a{color:#2979FF;text-decoration:none;margin-left:1.5rem;font-size:.9rem}
.header .links a:hover{color:#FF1D6C}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:1.5rem;padding:2rem;max-width:1400px;margin:0 auto}
.card{background:#111;border:1px solid #222;border-radius:12px;padding:1.5rem;transition:border-color .2s}
.card:hover{border-color:#FF1D6C}
.card h2{font-size:1.1rem;color:#F5A623;margin-bottom:1rem;display:flex;align-items:center;gap:.5rem}
.card.full{grid-column:1/-1}
.repo{display:flex;justify-content:space-between;align-items:center;padding:.6rem .8rem;border-radius:8px;margin-bottom:.4rem;background:#0d0d0d;border:1px solid #1a1a1a}
.repo:hover{border-color:#333}
.repo .name{font-weight:600;color:#e0e0e0;font-size:.9rem}
.repo .meta{font-size:.75rem;color:#666;display:flex;gap:.8rem}
.repo .lang{color:#2979FF}
.deploy{padding:.5rem .8rem;border-radius:6px;margin-bottom:.3rem;font-size:.85rem;background:#0d0d0d;border-left:3px solid #22c55e}
.deploy.deploying{border-left-color:#F5A623}
.deploy.failed{border-left-color:#ef4444}
.chat-box{background:#0d0d0d;border:1px solid #222;border-radius:8px;padding:1rem;min-height:200px;max-height:400px;overflow-y:auto;margin-bottom:1rem;font-size:.9rem}
.chat-box .msg{margin-bottom:.8rem;line-height:1.4}
.chat-box .user{color:#2979FF}
.chat-box .ai{color:#9C27B0}
.chat-input{display:flex;gap:.5rem}
.chat-input input{flex:1;background:#111;border:1px solid #333;border-radius:8px;padding:.7rem 1rem;color:#e0e0e0;font-size:.9rem}
.chat-input input:focus{outline:none;border-color:#FF1D6C}
.chat-input button{background:linear-gradient(135deg,#FF1D6C,#F5A623);border:none;border-radius:8px;padding:.7rem 1.5rem;color:#000;font-weight:700;cursor:pointer}
.stat{text-align:center;padding:1rem}
.stat .num{font-size:2.5rem;font-weight:800;background:linear-gradient(90deg,#FF1D6C,#F5A623);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.stat .label{font-size:.8rem;color:#666;margin-top:.3rem}
.stats-row{display:flex;justify-content:space-around}
.mirror-btn{background:#1a1a2e;border:1px solid #333;border-radius:8px;padding:.5rem 1rem;color:#2979FF;cursor:pointer;font-size:.85rem;margin-top:.5rem}
.mirror-btn:hover{border-color:#2979FF}
#loading{color:#666;text-align:center;padding:2rem}
</style>
</head>
<body>
<div class="header">
  <h1>⚡ BlackRoad Platform</h1>
  <div class="links">
    <a href="${giteaUrl}" target="_blank">Gitea</a>
    <a href="/api/health">API</a>
    <a href="/api/repos">Repos</a>
    <a href="/api/deploys">Deploys</a>
  </div>
</div>

<div class="grid">
  <div class="card">
    <h2>📊 Overview</h2>
    <div class="stats-row">
      <div class="stat"><div class="num" id="repo-count">-</div><div class="label">Repos</div></div>
      <div class="stat"><div class="num" id="deploy-count">-</div><div class="label">Deploys</div></div>
      <div class="stat"><div class="num" id="mirror-count">-</div><div class="label">Mirrors</div></div>
    </div>
  </div>

  <div class="card">
    <h2>🤖 AI Chat</h2>
    <div class="chat-box" id="chat-box"></div>
    <div class="chat-input">
      <input type="text" id="chat-input" placeholder="Ask about any repo..." onkeydown="if(event.key==='Enter')sendChat()">
      <button onclick="sendChat()">Send</button>
    </div>
  </div>

  <div class="card">
    <h2>📦 Repositories</h2>
    <div id="repos"><div id="loading">Loading...</div></div>
  </div>

  <div class="card">
    <h2>🚀 Recent Deploys</h2>
    <div id="deploys"><div id="loading">Loading...</div></div>
  </div>

  <div class="card full">
    <h2>🔗 Mirror GitHub Repo</h2>
    <div class="chat-input">
      <input type="text" id="mirror-input" placeholder="owner/repo (e.g. blackboxprogramming/blackroad)">
      <button onclick="mirrorRepo()">Mirror to Gitea</button>
    </div>
    <div id="mirror-status" style="margin-top:.5rem;font-size:.85rem;color:#666"></div>
  </div>
</div>

<script>
const API = window.location.origin;

async function loadRepos() {
  try {
    const res = await fetch(API + '/api/repos');
    const data = await res.json();
    document.getElementById('repo-count').textContent = data.count || 0;
    document.getElementById('mirror-count').textContent = (data.repos||[]).filter(r=>r.mirror).length;
    const el = document.getElementById('repos');
    el.innerHTML = (data.repos||[]).map(r => \`
      <div class="repo">
        <div>
          <div class="name">\${r.name}</div>
          <div class="meta"><span class="lang">\${r.language||'—'}</span><span>\${new Date(r.updated).toLocaleDateString()}</span>\${r.mirror?'<span>🔗 mirror</span>':''}</div>
        </div>
      </div>
    \`).join('') || '<div style="color:#666">No repos yet</div>';
  } catch(e) { document.getElementById('repos').innerHTML = '<div style="color:#ef4444">Failed to load</div>'; }
}

async function loadDeploys() {
  try {
    const res = await fetch(API + '/api/deploys');
    const data = await res.json();
    document.getElementById('deploy-count').textContent = (data.deploys||[]).length;
    const el = document.getElementById('deploys');
    el.innerHTML = (data.deploys||[]).map(d => \`
      <div class="deploy \${d.status}">
        <strong>\${d.repo}</strong> → \${d.status} (\${d.commits} commits) <span style="color:#666;float:right">\${new Date(d.timestamp).toLocaleString()}</span>
      </div>
    \`).join('') || '<div style="color:#666">No deploys yet</div>';
  } catch(e) { document.getElementById('deploys').innerHTML = '<div style="color:#ef4444">Failed to load</div>'; }
}

async function sendChat() {
  const input = document.getElementById('chat-input');
  const msg = input.value.trim();
  if (!msg) return;
  input.value = '';
  const box = document.getElementById('chat-box');
  box.innerHTML += '<div class="msg"><span class="user">You:</span> ' + msg + '</div>';
  box.scrollTop = box.scrollHeight;
  try {
    const res = await fetch(API + '/api/chat', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:msg})});
    const data = await res.json();
    box.innerHTML += '<div class="msg"><span class="ai">BlackRoad AI:</span> ' + (data.response||'No response').replace(/\\n/g,'<br>') + '</div>';
  } catch(e) { box.innerHTML += '<div class="msg" style="color:#ef4444">Error: ' + e.message + '</div>'; }
  box.scrollTop = box.scrollHeight;
}

async function mirrorRepo() {
  const input = document.getElementById('mirror-input');
  const repo = input.value.trim();
  if (!repo) return;
  document.getElementById('mirror-status').textContent = 'Mirroring...';
  try {
    const res = await fetch(API + '/api/mirror', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({github_repo:repo})});
    const data = await res.json();
    document.getElementById('mirror-status').textContent = data.mirrored ? '✅ Mirrored: ' + data.gitea_repo : '❌ ' + (data.error||'Failed');
    loadRepos();
  } catch(e) { document.getElementById('mirror-status').textContent = '❌ ' + e.message; }
}

loadRepos();
loadDeploys();
</script>
</body>
</html>`;
}
