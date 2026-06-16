const express = require('express');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const CHECK_INTERVAL = 60 * 1000; // 60秒检查一次

const TASKS_FILE = path.join(__dirname, 'tasks.json');
let notifiedSet = new Set();
let userTasks = {}; // { userId: { name, wecomWebhook, tasks: [...] } }

// 从文件恢复
function loadTasks() {
  try {
    if (fs.existsSync(TASKS_FILE)) {
      const raw = fs.readFileSync(TASKS_FILE, 'utf8');
      const data = JSON.parse(raw);
      notifiedSet = new Set(data.notified || []);

      // 多用户格式: { users: { userId: { name, wecomWebhook, tasks: {tasks:{todo/doing/done}} } } }
      if (data.users) {
        userTasks = {};
        Object.entries(data.users).forEach(([uid, udata]) => {
          const tc = (udata.tasks && udata.tasks.tasks) || {};
          const active = [...(tc.todo || []), ...(tc.doing || [])];
          userTasks[uid] = {
            name: udata.name || uid,
            wecomWebhook: udata.wecomWebhook || '',
            tasks: active
          };
        });
        const total = Object.values(userTasks).reduce((s,u) => s + u.tasks.length, 0);
        console.log(`[启动] 加载 ${Object.keys(userTasks).length} 个用户, ${total} 个活跃任务`);
      } else {
        // 旧格式兼容
        const tasksObj = data.tasks || data;
        const active = Array.isArray(tasksObj) ? tasksObj : [...(tasksObj.todo || []), ...(tasksObj.doing || [])];
        userTasks = { default: { name: '默认用户', wecomWebhook: process.env.WECOM_WEBHOOK || '', tasks: active } };
        console.log(`[启动] 旧格式: 加载 ${active.length} 个活跃任务`);
      }
    } else {
      console.log('[启动] 无 tasks.json，等待客户端同步...');
    }
  } catch(e) {
    console.error('[启动] 加载任务失败:', e.message);
  }
}

// 持久化通知记录
function persistNotified() {
  try {
    let data = {};
    if (fs.existsSync(TASKS_FILE)) {
      data = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
    }
    data.notified = [...notifiedSet];
    data.savedAt = new Date().toISOString();
    fs.writeFileSync(TASKS_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch(e) {
    console.error('[保存] 失败:', e.message);
  }
}

// 企业微信推送 (per-user webhook)
function sendWeCom(webhook, content) {
  return new Promise((resolve, reject) => {
    if (!webhook) return reject(new Error('无 Webhook 地址'));
    const body = JSON.stringify({
      msgtype: 'text',
      text: { content: content }
    });
    const url = new URL(webhook);
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body, 'utf8')
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.errcode === 0) resolve(result);
          else reject(new Error(result.errmsg || '未知错误'));
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// 定时检查预约任务 (多用户)
function checkReminders() {
  const now = new Date();
  const nowISO = now.toISOString();
  let sent = 0;

  Object.entries(userTasks).forEach(([uid, user]) => {
    if (!user.tasks || user.tasks.length === 0) return;
    user.tasks.forEach(t => {
      if (!t.scheduledAt) return;
      if (t.scheduledAt > nowISO) return;

      const key = `${uid}-${t.id}-${t.scheduledAt}`;
      if (notifiedSet.has(key)) return;

      const timeStr = new Date(t.scheduledAt).toLocaleString('zh-CN', {
        month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short',
        timeZone: 'Asia/Shanghai'
      });

      const msg =
        `⏰ 预约提醒\n` +
        `用户：${user.name}\n` +
        `任务：${t.text || '(无标题)'}\n` +
        `预约时间：${timeStr}\n` +
        `状态：已到期\n` +
        `\n请及时查看看板处理`;

      sendWeCom(user.wecomWebhook, msg).then(() => {
        notifiedSet.add(key);
        console.log(`[通知] [${user.name}] 已发送: ${t.text} (${timeStr})`);
        persistNotified();
      }).catch(err => {
        console.error(`[通知] [${user.name}] 发送失败: ${t.text} - ${err.message}`);
      });

      sent++;
    });
  });

  if (sent > 0) {
    console.log(`[检查] 本次发送 ${sent} 条提醒`);
  }
}

// Express 服务
const app = express();
app.use(express.json({ limit: '2mb' }));

app.get('/', (req, res) => {
  const total = Object.values(userTasks).reduce((s,u) => s + u.tasks.length, 0);
  res.json({
    service: '看板云端提醒服务',
    status: 'running',
    users: Object.keys(userTasks).length,
    tasks: total,
    notified: notifiedSet.size,
    uptime: Math.floor(process.uptime()),
    time: new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  const total = Object.values(userTasks).reduce((s,u) => s + u.tasks.length, 0);
  res.json({
    status: 'ok',
    users: Object.keys(userTasks).length,
    tasks: total,
    notified: notifiedSet.size,
    uptime: Math.floor(process.uptime()),
    time: new Date().toISOString()
  });
});

// 同步任务 (Electron 桌面端调用，多用户格式)
app.post('/sync', (req, res) => {
  try {
    const body = req.body;
    // 新格式: { users: { userId: { name, wecomWebhook, tasks: {tasks:{todo/doing/done}} } } }
    if (body.users) {
      userTasks = {};
      Object.entries(body.users).forEach(([uid, udata]) => {
        const tc = (udata.tasks && udata.tasks.tasks) || {};
        const active = [...(tc.todo || []), ...(tc.doing || [])];
        userTasks[uid] = {
          name: udata.name || uid,
          wecomWebhook: udata.wecomWebhook || '',
          tasks: active
        };
      });
    } else {
      // 旧格式兼容
      const tasksObj = body.tasks || body;
      const active = Array.isArray(tasksObj) ? tasksObj : [...(tasksObj.todo || []), ...(tasksObj.doing || [])];
      userTasks = { default: { name: '默认用户', wecomWebhook: process.env.WECOM_WEBHOOK || '', tasks: active } };
    }

    // 写文件 (云端持久化)
    fs.writeFileSync(TASKS_FILE, JSON.stringify({
      users: Object.fromEntries(
        Object.entries(userTasks).map(([uid, u]) => [uid, {
          name: u.name,
          wecomWebhook: u.wecomWebhook,
          tasks: { tasks: { todo: u.tasks.filter(t => !t.done), doing: u.tasks.filter(t => !t.done), done: [] } }
        }])
      ),
      notified: [...notifiedSet],
      savedAt: new Date().toISOString()
    }, null, 2), 'utf8');

    const total = Object.values(userTasks).reduce((s,u) => s + u.tasks.length, 0);
    console.log(`[同步] ${Object.keys(userTasks).length} 个用户, ${total} 个活跃任务`);
    res.json({ ok: true, users: Object.keys(userTasks).length, tasks: total });
  } catch(e) {
    console.error('[同步] 失败:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/check', (req, res) => {
  checkReminders();
  res.json({ ok: true, notified: notifiedSet.size });
});

// 启动
loadTasks();
checkReminders();

app.listen(PORT, '0.0.0.0', () => {
  const total = Object.values(userTasks).reduce((s,u) => s + u.tasks.length, 0);
  console.log(`[云端提醒] 服务已启动 http://0.0.0.0:${PORT}`);
  console.log(`[云端提醒] ${Object.keys(userTasks).length} 个用户, ${total} 个任务, 检查间隔 ${CHECK_INTERVAL/1000}s`);
});

setInterval(checkReminders, CHECK_INTERVAL);
