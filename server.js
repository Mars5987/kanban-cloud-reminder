const express = require('express');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const CHECK_INTERVAL = 60 * 1000; // 60秒检查一次

// ===== 企业微信 Webhook =====
const WECOM_WEBHOOK = process.env.WECOM_WEBHOOK ||
  'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=0fa74ba0-501d-429f-b552-93cca22ea535';

// ===== 任务存储 =====
const TASKS_FILE = path.join(__dirname, 'tasks.json');
let tasks = [];           // 扁平化的活跃任务列表
let notifiedSet = new Set(); // 已通知的 taskId-scheduledAt
let fullData = null;      // 完整原始数据（含 nextId/nextSeq）

// ===== 辅助：从 {todo/doing/done} 对象提取活跃任务 =====
function extractActive(tasksObj) {
  if (Array.isArray(tasksObj)) return tasksObj;
  // {todo:[], doing:[], done:[]} 格式
  if (tasksObj && typeof tasksObj === 'object') {
    return [...(tasksObj.todo || []), ...(tasksObj.doing || [])];
  }
  return [];
}

// 从文件恢复
function loadTasks() {
  try {
    if (fs.existsSync(TASKS_FILE)) {
      const raw = fs.readFileSync(TASKS_FILE, 'utf8');
      const data = JSON.parse(raw);
      // Electron 保存格式: { tasks: {todo/doing/done}, nextId, nextSeq }
      // check_remind.py 格式: { tasks: [...], notified: [...] }
      // 纯 {todo/doing/done} 格式（直接对象）
      const tasksObj = data.tasks || data;
      fullData = data;
      tasks = extractActive(tasksObj);
      notifiedSet = new Set(data.notified || []);
      console.log(`[启动] 加载 ${tasks.length} 个活跃任务, ${notifiedSet.size} 条通知记录`);
    } else {
      console.log('[启动] 无 tasks.json，等待客户端同步...');
    }
  } catch(e) {
    console.error('[启动] 加载任务失败:', e.message);
  }
}

// 持久化（保存完整数据 + notified）
function saveData(newFullData) {
  try {
    const toSave = {
      tasks: newFullData || fullData || { tasks: {} },
      notified: [...notifiedSet],
      lastSync: new Date().toISOString()
    };
    // 如果是 { tasks: {todo/doing/done}, nextId, nextSeq } 格式，保留完整结构
    if (fullData && fullData.tasks && typeof fullData.tasks === 'object' && !Array.isArray(fullData.tasks)) {
      toSave.tasks = fullData.tasks;
      toSave.nextId = fullData.nextId;
      toSave.nextSeq = fullData.nextSeq;
    }
    toSave.notified = [...notifiedSet];
    toSave.savedAt = new Date().toISOString();
    fs.writeFileSync(TASKS_FILE, JSON.stringify(toSave, null, 2), 'utf8');
  } catch(e) {
    console.error('[保存] 失败:', e.message);
  }
}

// ===== 企业微信推送 =====
function sendWeCom(content) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      msgtype: 'text',
      text: { content: content }
    });
    const url = new URL(WECOM_WEBHOOK);
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

// ===== 定时检查预约任务 =====
function checkReminders() {
  const now = new Date();
  const nowISO = now.toISOString();
  let sent = 0;

  for (const t of tasks) {
    if (!t.scheduledAt) continue;
    if (t.scheduledAt > nowISO) continue; // 还没到期

    const key = `${t.id}-${t.scheduledAt}`;
    if (notifiedSet.has(key)) continue; // 已通知过

    const timeStr = new Date(t.scheduledAt).toLocaleString('zh-CN', {
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short',
      timeZone: 'Asia/Shanghai'
    });

    const msg =
      `⏰ 预约提醒\n` +
      `任务：${t.text || '(无标题)'}\n` +
      `预约时间：${timeStr}\n` +
      `状态：已到期\n` +
      `\n请及时查看看板处理`;

    sendWeCom(msg).then(() => {
      notifiedSet.add(key);
      console.log(`[通知] 已发送: ${t.text} (${timeStr})`);
      saveData(); // 持久化通知记录
    }).catch(err => {
      console.error(`[通知] 发送失败: ${t.text} - ${err.message}`);
    });

    sent++;
  }

  if (sent > 0) {
    console.log(`[检查] 本次发送 ${sent} 条提醒`);
  }
}

// ===== Express 服务 =====
const app = express();
app.use(express.json({ limit: '1mb' }));

// 首页（确认服务存活）
app.get('/', (req, res) => {
  res.json({
    service: '看板云端提醒服务',
    status: 'running',
    tasks: tasks.length,
    notified: notifiedSet.size,
    uptime: Math.floor(process.uptime()),
    time: new Date().toISOString()
  });
});

// 健康检查
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    tasks: tasks.length,
    notified: notifiedSet.size,
    uptime: Math.floor(process.uptime()),
    time: new Date().toISOString()
  });
});

// 同步任务（Electron 桌面端调用）
app.post('/sync', (req, res) => {
  try {
    const body = req.body;
    // body = { tasks: {todo:[], doing:[], done:[]}, nextId: ..., nextSeq: ... }
    const tasksObj = body.tasks || body;

    // 保存完整原始数据
    fullData = body;

    // 提取活跃任务（todo + doing，忽略 done）
    tasks = extractActive(tasksObj);

    // 写文件（云端持久化，重启后可恢复）
    fs.writeFileSync(TASKS_FILE, JSON.stringify({
      tasks: typeof tasksObj === 'object' && !Array.isArray(tasksObj) ? tasksObj : tasks,
      nextId: body.nextId,
      nextSeq: body.nextSeq,
      notified: [...notifiedSet],
      savedAt: new Date().toISOString()
    }, null, 2), 'utf8');

    console.log(`[同步] 收到 ${tasks.length} 个活跃任务 (todo:${(tasksObj.todo||[]).length} doing:${(tasksObj.doing||[]).length})`);
    res.json({ ok: true, count: tasks.length });
  } catch(e) {
    console.error('[同步] 失败:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// 手动触发检查
app.post('/check', (req, res) => {
  checkReminders();
  res.json({ ok: true, notified: notifiedSet.size });
});

// 启动
loadTasks();
checkReminders(); // 启动时立即检查一次

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[云端提醒] 服务已启动 http://0.0.0.0:${PORT}`);
  console.log(`[云端提醒] 检查间隔: ${CHECK_INTERVAL / 1000}秒`);
  console.log(`[云端提醒] Webhook: ${WECOM_WEBHOOK.substring(0, 60)}...`);
});

// 定时检查
setInterval(checkReminders, CHECK_INTERVAL);
