#!/usr/bin/env python3
"""看板云端预约提醒 - 检查到期任务并推送企业微信"""
import json, os, sys
from datetime import datetime, timezone, timedelta
from urllib.request import Request, urlopen
from urllib.error import URLError

WECOM_WEBHOOK = os.environ.get("WECOM_WEBHOOK", "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=0fa74ba0-501d-429f-b552-93cca22ea535")
TASKS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tasks.json")
BEIJING_TZ = timezone(timedelta(hours=8))

def load_tasks():
    try:
        with open(TASKS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        tasks_obj = data.get("tasks", {})
        # 兼容两种格式：扁平数组 或 {todo/doing/done} 对象
        if isinstance(tasks_obj, list):
            all_tasks = tasks_obj
        else:
            all_tasks = tasks_obj.get("todo", []) + tasks_obj.get("doing", [])
        return all_tasks, set(data.get("notified", []))
    except:
        return [], set()

def save_notified(notified_set):
    try:
        if os.path.exists(TASKS_FILE):
            with open(TASKS_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
        else:
            data = {"tasks": {}}
        data["notified"] = list(notified_set)
        data["savedAt"] = datetime.now(BEIJING_TZ).isoformat()
        with open(TASKS_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"[保存] 失败: {e}")

def send_wecom(msg):
    body = json.dumps({"msgtype": "text", "text": {"content": msg}}, ensure_ascii=False).encode("utf-8")
    req = Request(WECOM_WEBHOOK, data=body, headers={
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
    tasks, notified_set = load_tasks()
    now = datetime.now(BEIJING_TZ)
    now_iso = now.isoformat()
    sent = 0

    for t in tasks:
        if not t.get("scheduledAt"):
            continue
        if t["scheduledAt"] > now_iso:
            continue

        key = f"{t['id']}-{t['scheduledAt']}"
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

        msg = (
            f"⏰ 预约提醒\n"
            f"任务：{t.get('text', '(无标题)')}\n"
            f"预约时间：{time_str}\n"
            f"状态：已到期\n"
            f"\n请及时查看看板处理"
        )

        ok, err = send_wecom(msg)
        if ok:
            notified_set.add(key)
            print(f"[通知] 已发送: {t.get('text', '')} ({time_str})")
        else:
            print(f"[通知] 发送失败: {t.get('text', '')} - {err}")

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
