import WebSocket from 'ws';
import http from 'http';

function getPages() {
  return new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:9222/json', res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
}

let _id = 1;
function cdpSend(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = _id++;
    const handler = (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id === id) {
        ws.removeListener('message', handler);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { ws.removeListener('message', handler); reject(new Error('timeout')); }, 10000);
  });
}

async function main() {
  const pages = await getPages();
  const target = pages.find(p => p.url?.includes('workspace.nexos.ai')) || pages.find(p => p.type === 'page');
  if (!target) { console.error('No nexos page found'); process.exit(1); }
  console.error('Using page:', target.url);

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r => ws.once('open', r));

  // 获取 workspace.nexos.ai 的所有 cookies
  const { cookies } = await cdpSend(ws, 'Network.getCookies', { urls: ['https://workspace.nexos.ai', 'https://login.nexos.ai'] });

  // 输出为 Python requests 兼容格式
  const cookieDict = {};
  for (const c of cookies) {
    cookieDict[c.name] = c.value;
  }
  console.log(JSON.stringify(cookieDict));
  ws.close();
}

main().catch(e => { console.error(e); process.exit(1); });
