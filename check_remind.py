#!/usr/bin/env python3
"""看板云端预约提醒 - 多用户支持，检查到期任务并推送到各自企业微信"""
import json, os, sys
from datetime import datetime, timezone, timedelta
from urllib.request import Request, urlopen
from urllib.error import URLError

TASKS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tasks.json")
BEIJING_TZ = timezone(timedelta(hours=8))

# 兼容旧版单一 webhook 环境变量
DEFAULT_WEBHOOK = os.environ.get("WECOM_WEBHOOK", "")

def load_data():
    """加载多用户任务数据
    新格式: { users: { userId: { name, wecomWebhook, tasks: {tasks:{todo/doing/done},nextId,nextSeq} } }, notified: [...], savedAt: "..." }
    旧格式兼容: { tasks: {todo/doing/done}, nextId, nextSeq }
    """
    try:
        with open(TASKS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
    except:
        return [], set()

    users_data = data.get("users", {})
    notified_set = set(data.get("notified", []))

    # 新格式：多用户
    if users_data:
        all_tasks = []
        for uid, udata in users_data.items():
            task_container = udata.get("tasks", {})
            tasks_obj = task_container.get("tasks", {})
            if isinstance(tasks_obj, list):
                user_tasks = tasks_obj
            else:
                user_tasks = tasks_obj.get("todo", []) + tasks_obj.get("doing", [])
            webhook = udata.get("wecomWebhook", "") or DEFAULT_WEBHOOK
            for t in user_tasks:
                t["_userId"] = uid
                t["_wecomWebhook"] = webhook
                t["_userName"] = udata.get("name", uid)
            all_tasks.extend(user_tasks)
        return all_tasks, notified_set

    # 旧格式兼容：扁平结构
    tasks_obj = data.get("tasks", {})
    if isinstance(tasks_obj, list):
        all_tasks = tasks_obj
    else:
        all_tasks = tasks_obj.get("todo", []) + tasks_obj.get("doing", [])
    for t in all_tasks:
        t["_userId"] = "default"
        t["_wecomWebhook"] = DEFAULT_WEBHOOK
        t["_userName"] = "默认用户"
    return all_tasks, notified_set


def save_notified(notified_set):
    try:
        if os.path.exists(TASKS_FILE):
            with open(TASKS_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
        else:
            data = {}
        data["notified"] = list(notified_set)
        data["savedAt"] = datetime.now(BEIJING_TZ).isoformat()
        with open(TASKS_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"[保存] 失败: {e}")


def send_wecom(webhook, msg):
    if not webhook:
        return False, "无 Webhook 地址"
    body = json.dumps({"msgtype": "text", "text": {"content": msg}}, ensure_ascii=False).encode("utf-8")
    req = Request(webhook, data=body, headers={
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": str(len(body))
    }, method="POST")
    try:
        with urlopen(req, timeout=10) as resp:
            result = json.loads(resp.read().decode("utf-8"))
            if result.get("errcode") == 0:
                return True, "ok"
            return False, result.get("errmsg", "未知错误")
    except URLError as e:
        return False, str(e)


def check_reminders():
    tasks, notified_set = load_data()
    now = datetime.now(BEIJING_TZ)
    now_iso = now.isoformat()
    sent = 0

    for t in tasks:
        if not t.get("scheduledAt"):
            continue
        if t["scheduledAt"] > now_iso:
            continue

        uid = t.get("_userId", "default")
        webhook = t.get("_wecomWebhook", "")
        key = f"{uid}-{t['id']}-{t['scheduledAt']}"
        if key in notified_set:
            continue

        # 格式化时间
        try:
            dt = datetime.fromisoformat(t["scheduledAt"])
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            dt_local = dt.astimezone(BEIJING_TZ)
            weekdays = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]
            time_str = f"{dt_local.strftime('%m-%d %H:%M')} {weekdays[dt_local.weekday()]}"
        except:
            time_str = t["scheduledAt"][:16]

        user_name = t.get("_userName", uid)
        msg = (
            f"⏰ 预约提醒\n"
            f"用户：{user_name}\n"
            f"任务：{t.get('text', '(无标题)')}\n"
            f"预约时间：{time_str}\n"
            f"状态：已到期\n"
            f"\n请及时查看看板处理"
        )

        ok, err = send_wecom(webhook, msg)
        if ok:
            notified_set.add(key)
            print(f"[通知] [{user_name}] 已发送: {t.get('text', '')} ({time_str})")
        else:
            print(f"[通知] [{user_name}] 发送失败: {t.get('text', '')} - {err}")

        sent += 1

    if sent > 0:
        save_notified(notified_set)
        print(f"[汇总] 本次发送 {sent} 条通知")
    else:
        print(f"[检查] {now.strftime('%H:%M:%S')} 无到期任务")

    return sent


if __name__ == "__main__":
    print(f"[云端提醒] 检查时间: {datetime.now(BEIJING_TZ).strftime('%Y-%m-%d %H:%M:%S')}")
    check_reminders()
