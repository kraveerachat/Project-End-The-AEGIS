"""Thai / English / Chinese wording for the control Desktop's CUT and RESTORE dialogs, captions, button texts and result lines.

Translation happens at display time only. The internal English identifiers stay exactly as they are: the base classes find their
widgets by the English texts ("CUT NETWORK — DISABLED"), the clients return English ``View.text`` sentences, and the tests and the
audit trail see English. The confirmation words, state codes (PUBLISHED, REFUSED_AUTH, ...), command words (CUT, RESTORE), reason
codes and addresses are never translated. A sentence that has no translation here is shown in English, never dropped.
"""

from __future__ import annotations

import re

LANGUAGES = ("en", "th", "zh")

# Fixed wording (key -> language -> text; {word} / {limit} etc. are placeholders).
CONTROL_STRINGS = {
    "control.caption": {"en": "OPERATOR CONTROLS — CORE-AUTHENTICATED", "th": "การควบคุมโดยผู้ปฏิบัติงาน — ยืนยันตัวตนผ่าน Core",
                        "zh": "操作员控制 — 由 Core 认证"},
    "control.caption_note": {"en": "CUT and RESTORE — each verified by the Core", "th": "CUT และ RESTORE — Core ตรวจสอบทุกครั้ง",
                             "zh": "CUT 与 RESTORE — 每次均由 Core 验证"},
    "control.cut_button": {"en": "CUT NETWORK (Core-authenticated)", "th": "CUT เครือข่าย (ยืนยันผ่าน Core)", "zh": "CUT 网络（Core 认证）"},
    "control.restore_button": {"en": "RESTORE NETWORK (Core-authenticated)", "th": "RESTORE เครือข่าย (ยืนยันผ่าน Core)",
                               "zh": "RESTORE 网络（Core 认证）"},
    "control.restore_disabled": {"en": "RESTORE NETWORK — DISABLED", "th": "RESTORE เครือข่าย — ปิดใช้งาน", "zh": "RESTORE 网络 — 已禁用"},
    "dialog.cut_title": {"en": "Manual CUT", "th": "CUT ด้วยมือ", "zh": "手动 CUT"},
    "dialog.restore_title": {"en": "RESTORE", "th": "RESTORE", "zh": "RESTORE"},
    "dialog.cut_reason": {"en": "Reason for this CUT (12-240 characters):", "th": "เหตุผลของ CUT นี้ (12-240 ตัวอักษร):",
                          "zh": "本次 CUT 的原因（12-240 个字符）："},
    "dialog.restore_reason": {"en": "Reason for this RESTORE (12-240 characters):", "th": "เหตุผลของ RESTORE นี้ (12-240 ตัวอักษร):",
                              "zh": "本次 RESTORE 的原因（12-240 个字符）："},
    "dialog.confirm": {"en": "Type {word} to confirm your intent:", "th": "พิมพ์ {word} เพื่อยืนยันเจตนาของคุณ:",
                       "zh": "请输入 {word} 以确认您的意图："},
    "dialog.cut_secret": {"en": "CUT secret (verified by the Core; never stored):", "th": "รหัสลับ CUT (Core เป็นผู้ตรวจสอบ ไม่มีการเก็บไว้):",
                          "zh": "CUT 密钥（由 Core 验证，从不存储）："},
    "dialog.restore_secret": {"en": "RESTORE secret (verified by the Core; never stored):",
                              "th": "รหัสลับ RESTORE (Core เป็นผู้ตรวจสอบ ไม่มีการเก็บไว้):", "zh": "RESTORE 密钥（由 Core 验证，从不存储）："},
    "notice.confirm_mismatch": {"en": "Confirmation did not match. Nothing was sent.",
                                "th": "ข้อความยืนยันไม่ตรงกัน ไม่มีการส่งคำสั่งใด ๆ", "zh": "确认内容不匹配。未发送任何指令。"},
    "notice.auth_required": {"en": "Authentication is required. Nothing was sent.", "th": "ต้องยืนยันตัวตน ไม่มีการส่งคำสั่งใด ๆ",
                             "zh": "需要认证。未发送任何指令。"},
    "notice.restore_secret_required": {"en": "The RESTORE secret is required. Nothing was sent.",
                                       "th": "ต้องใช้รหัสลับ RESTORE ไม่มีการส่งคำสั่งใด ๆ", "zh": "需要 RESTORE 密钥。未发送任何指令。"},
}

_NS = {"en": "Nothing was sent.", "th": "ไม่มีการส่งคำสั่งใด ๆ", "zh": "未发送任何指令。"}


def _both(_english, th, zh):   # the English key is the sentence itself
    return {"th": th, "zh": zh}


# English sentence (exactly as the clients produce it) -> translations.
FLOW_TEXTS = {
    "No manual CUT in progress.": _both("", "ไม่มี CUT ด้วยมือที่กำลังดำเนินการ", "没有正在进行的手动 CUT。"),
    "No RESTORE in progress.": _both("", "ไม่มี RESTORE ที่กำลังดำเนินการ", "没有正在进行的 RESTORE。"),
    "A manual CUT is already in progress. Nothing new was sent.": _both("", "มี CUT ด้วยมือกำลังดำเนินการอยู่ ไม่มีการส่งคำสั่งใหม่", "手动 CUT 已在进行中。未发送新指令。"),
    "A RESTORE is already in progress. Nothing new was sent.": _both("", "มี RESTORE กำลังดำเนินการอยู่ ไม่มีการส่งคำสั่งใหม่", "RESTORE 已在进行中。未发送新指令。"),
    "A previous RESTORE awaits device evidence. Nothing new was sent.": _both(
        "", "RESTORE ก่อนหน้ากำลังรอหลักฐานจากอุปกรณ์ ไม่มีการส่งคำสั่งใหม่", "上一次 RESTORE 正在等待设备证据。未发送新指令。"),
    "Another command is still awaiting its ACK. Nothing new was sent.": _both(
        "", "ยังมีคำสั่งอื่นรอ ACK อยู่ ไม่มีการส่งคำสั่งใหม่", "仍有另一条指令在等待 ACK。未发送新指令。"),
    "Authentication failed. Nothing was sent.": _both("", "ยืนยันตัวตนไม่สำเร็จ " + _NS["th"], "认证失败。" + _NS["zh"]),
    "Authentication is temporarily locked after repeated failures. Nothing was sent.": _both(
        "", "การยืนยันตัวตนถูกล็อกชั่วคราวหลังล้มเหลวซ้ำ " + _NS["th"], "多次失败后认证被暂时锁定。" + _NS["zh"]),
    "Operator authentication is required. Nothing was sent.": _both("", "ต้องยืนยันตัวตนผู้ปฏิบัติงาน " + _NS["th"], "需要操作员认证。" + _NS["zh"]),
    "The RESTORE secret is required. Nothing was sent.": _both("", "ต้องใช้รหัสลับ RESTORE " + _NS["th"], "需要 RESTORE 密钥。" + _NS["zh"]),
    "A reason is required. Nothing was sent.": _both("", "ต้องระบุเหตุผล " + _NS["th"], "必须填写原因。" + _NS["zh"]),
    "The reason was not accepted. Nothing was sent.": _both("", "ไม่รับเหตุผลที่ระบุ " + _NS["th"], "原因未被接受。" + _NS["zh"]),
    "The typed confirmation was not accepted. Nothing was sent.": _both("", "ไม่รับข้อความยืนยันที่พิมพ์ " + _NS["th"], "输入的确认内容未被接受。" + _NS["zh"]),
    "The typed confirmation did not match. Nothing was sent.": _both("", "ข้อความยืนยันที่พิมพ์ไม่ตรงกัน " + _NS["th"], "输入的确认内容不匹配。" + _NS["zh"]),
    "The Core could not write its durable audit record. Nothing was sent.": _both(
        "", "Core เขียนบันทึกตรวจสอบถาวรไม่ได้ " + _NS["th"], "Core 无法写入持久审计记录。" + _NS["zh"]),
    "The Core does not accept this operator account.": _both("", "Core ไม่รับบัญชีผู้ปฏิบัติงานนี้", "Core 不接受此操作员账户。"),
    "The Core rejected the request origin. Nothing was sent.": _both("", "Core ปฏิเสธต้นทางของคำขอ " + _NS["th"], "Core 拒绝了请求来源。" + _NS["zh"]),
    "The Core rejected the request format. Nothing was sent.": _both("", "Core ปฏิเสธรูปแบบของคำขอ " + _NS["th"], "Core 拒绝了请求格式。" + _NS["zh"]),
    "The Core is in dry-run mode. Nothing was sent to the device.": _both(
        "", "Core อยู่ในโหมดทดลอง (dry-run) ไม่มีการส่งคำสั่งไปยังอุปกรณ์", "Core 处于试运行（dry-run）模式。未向设备发送任何指令。"),
    "The Core clock is not trusted. Nothing was sent.": _both("", "นาฬิกาของ Core ไม่น่าเชื่อถือ " + _NS["th"], "Core 时钟不可信。" + _NS["zh"]),
    "The Core could not reach its broker. Nothing was sent.": _both("", "Core ติดต่อโบรกเกอร์ไม่ได้ " + _NS["th"], "Core 无法连接代理服务器。" + _NS["zh"]),
    "The command expired at the Core. Nothing was sent.": _both("", "คำสั่งหมดอายุที่ Core " + _NS["th"], "指令在 Core 处已过期。" + _NS["zh"]),
    "The Core protocol store is unavailable. Nothing was sent.": _both("", "ที่เก็บโปรโตคอลของ Core ใช้งานไม่ได้ " + _NS["th"], "Core 协议存储不可用。" + _NS["zh"]),
    "The Core protocol is not configured. Nothing was sent.": _both("", "ยังไม่ได้ตั้งค่าโปรโตคอลของ Core " + _NS["th"], "Core 协议未配置。" + _NS["zh"]),
    "The Core CUT channel is closing. Nothing was sent.": _both("", "ช่องทาง CUT ของ Core กำลังปิด " + _NS["th"], "Core 的 CUT 通道正在关闭。" + _NS["zh"]),
    "The Core RESTORE channel is closing. Nothing was sent.": _both("", "ช่องทาง RESTORE ของ Core กำลังปิด " + _NS["th"], "Core 的 RESTORE 通道正在关闭。" + _NS["zh"]),
    "No trusted Core channel accepted the request; nothing was sent.": _both(
        "", "ไม่มีช่องทาง Core ที่เชื่อถือได้รับคำขอ ไม่มีการส่งคำสั่งใด ๆ", "没有可信的 Core 通道接受该请求；未发送任何指令。"),
    "The Core does not report LOCKDOWN, so there is nothing to restore.": _both(
        "", "Core ไม่ได้รายงาน LOCKDOWN จึงไม่มีสิ่งที่ต้อง RESTORE", "Core 未报告 LOCKDOWN，因此无需 RESTORE。"),
    "The Core's Recovery policy is not satisfied yet. Nothing was sent.": _both(
        "", "นโยบาย Recovery ของ Core ยังไม่เป็นไปตามเงื่อนไข " + _NS["th"], "Core 的 Recovery 策略尚未满足。" + _NS["zh"]),
    "The Core has no CUT command with that identifier.": _both("", "Core ไม่มีคำสั่ง CUT ที่ตรงกับรหัสนี้", "Core 没有该标识符对应的 CUT 指令。"),
    "The Core has no RESTORE with that identifier.": _both("", "Core ไม่มี RESTORE ที่ตรงกับรหัสนี้", "Core 没有该标识符对应的 RESTORE。"),
    "CUT published by the Core. Waiting for device ACK. Physical state is NOT proven.": _both(
        "", "Core ส่ง CUT แล้ว กำลังรอ ACK จากอุปกรณ์ ยังไม่ยืนยันสถานะทางกายภาพ", "Core 已发布 CUT，正在等待设备 ACK。物理状态尚未得到证实。"),
    "RESTORE published by the Core. Waiting for device ACK. Reconnection is NOT proven.": _both(
        "", "Core ส่ง RESTORE แล้ว กำลังรอ ACK จากอุปกรณ์ ยังไม่ยืนยันว่าเชื่อมต่อกลับแล้ว", "Core 已发布 RESTORE，正在等待设备 ACK。尚未证实已恢复连接。"),
    "CUT accepted but queued behind an in-flight RESTORE; it has no command id yet. Check Core evidence before acting again.": _both(
        "", "รับ CUT แล้วแต่ต้องรอหลัง RESTORE ที่กำลังดำเนินการ ยังไม่มีรหัสคำสั่ง ตรวจสอบหลักฐานจาก Core ก่อนทำซ้ำ",
        "CUT 已接受，但排在进行中的 RESTORE 之后；尚无指令 ID。再次操作前请检查 Core 证据。"),
    "Published. Waiting for the device ACK. Physical state is NOT proven.": _both(
        "", "ส่งแล้ว กำลังรอ ACK จากอุปกรณ์ ยังไม่ยืนยันสถานะทางกายภาพ", "已发布，正在等待设备 ACK。物理状态尚未得到证实。"),
    "Published. Waiting for the device ACK. Reconnection is NOT proven.": _both(
        "", "ส่งแล้ว กำลังรอ ACK จากอุปกรณ์ ยังไม่ยืนยันว่าเชื่อมต่อกลับแล้ว", "已发布，正在等待设备 ACK。尚未证实已恢复连接。"),
    "The device ACKed. Waiting for its STATUS. Physical state is NOT proven.": _both(
        "", "อุปกรณ์ตอบ ACK แล้ว กำลังรอ STATUS ยังไม่ยืนยันสถานะทางกายภาพ", "设备已确认 ACK，正在等待其 STATUS。物理状态尚未得到证实。"),
    "The device ACKed. Waiting for its STATUS. Reconnection is NOT proven.": _both(
        "", "อุปกรณ์ตอบ ACK แล้ว กำลังรอ STATUS ยังไม่ยืนยันว่าเชื่อมต่อกลับแล้ว", "设备已确认 ACK，正在等待其 STATUS。尚未证实已恢复连接。"),
    "The device ACKed and reported LOCKDOWN (protocol evidence). Physical disconnection is NOT proven; verify with the cable tester.": _both(
        "", "อุปกรณ์ตอบ ACK และรายงาน LOCKDOWN (หลักฐานจากโปรโตคอล) ยังไม่ยืนยันว่าตัดการเชื่อมต่อทางกายภาพ โปรดตรวจด้วยเครื่องทดสอบสาย",
        "设备已确认 ACK 并报告 LOCKDOWN（协议证据）。物理断开尚未得到证实；请用线缆测试仪核实。"),
    "The device ACKed and reported NORMAL (protocol evidence). Reconnection is NOT proven; verify with the cable tester.": _both(
        "", "อุปกรณ์ตอบ ACK และรายงาน NORMAL (หลักฐานจากโปรโตคอล) ยังไม่ยืนยันว่าเชื่อมต่อกลับแล้ว โปรดตรวจด้วยเครื่องทดสอบสาย",
        "设备已确认 ACK 并报告 NORMAL（协议证据）。尚未证实已恢复连接；请用线缆测试仪核实。"),
    "The device ACKed and sent a correlated STATUS, but this Core process did not observe the final state. Physical state is NOT proven.": _both(
        "", "อุปกรณ์ตอบ ACK และส่ง STATUS ที่สัมพันธ์กัน แต่โปรเซส Core นี้ไม่ได้เห็นสถานะสุดท้าย ยังไม่ยืนยันสถานะทางกายภาพ",
        "设备已确认 ACK 并发送了相关 STATUS，但本 Core 进程未观察到最终状态。物理状态尚未得到证实。"),
    "The device ACKed and sent a correlated STATUS, but this Core process did not observe the final state. Reconnection is NOT proven.": _both(
        "", "อุปกรณ์ตอบ ACK และส่ง STATUS ที่สัมพันธ์กัน แต่โปรเซส Core นี้ไม่ได้เห็นสถานะสุดท้าย ยังไม่ยืนยันว่าเชื่อมต่อกลับแล้ว",
        "设备已确认 ACK 并发送了相关 STATUS，但本 Core 进程未观察到最终状态。尚未证实已恢复连接。"),
    "The Core reports the command was NOT published.": _both("", "Core รายงานว่าคำสั่งไม่ได้ถูกส่ง", "Core 报告该指令未发布。"),
    "The Core reports the RESTORE was NOT published.": _both("", "Core รายงานว่า RESTORE ไม่ได้ถูกส่ง", "Core 报告该 RESTORE 未发布。"),
    "The Core cannot confirm publication. Do not assume the CUT happened.": _both(
        "", "Core ยืนยันการส่งไม่ได้ อย่าสันนิษฐานว่า CUT เกิดขึ้นแล้ว", "Core 无法确认是否已发布。请勿假定 CUT 已发生。"),
    "The Core cannot confirm publication. Do not assume the RESTORE happened.": _both(
        "", "Core ยืนยันการส่งไม่ได้ อย่าสันนิษฐานว่า RESTORE เกิดขึ้นแล้ว", "Core 无法确认是否已发布。请勿假定 RESTORE 已发生。"),
    "The Core cannot tell whether the device received the CUT. Do not assume it happened.": _both(
        "", "Core บอกไม่ได้ว่าอุปกรณ์ได้รับ CUT หรือไม่ อย่าสันนิษฐานว่าเกิดขึ้นแล้ว", "Core 无法判断设备是否收到 CUT。请勿假定已发生。"),
    "The Core cannot tell whether the device received the RESTORE.": _both(
        "", "Core บอกไม่ได้ว่าอุปกรณ์ได้รับ RESTORE หรือไม่", "Core 无法判断设备是否收到 RESTORE。"),
    "The Core evidence cannot be read. The CUT was published; its ACK/STATUS is unknown. Do not assume success.": _both(
        "", "อ่านหลักฐานจาก Core ไม่ได้ CUT ถูกส่งแล้ว แต่ไม่ทราบ ACK/STATUS อย่าสันนิษฐานว่าสำเร็จ",
        "无法读取 Core 证据。CUT 已发布，其 ACK/STATUS 未知。请勿假定成功。"),
    "The Core evidence cannot be read. The RESTORE was published; its ACK/STATUS is unknown. Do not assume success.": _both(
        "", "อ่านหลักฐานจาก Core ไม่ได้ RESTORE ถูกส่งแล้ว แต่ไม่ทราบ ACK/STATUS อย่าสันนิษฐานว่าสำเร็จ",
        "无法读取 Core 证据。RESTORE 已发布，其 ACK/STATUS 未知。请勿假定成功。"),
    "The Core did not return evidence for this command.": _both("", "Core ไม่ส่งหลักฐานของคำสั่งนี้กลับมา", "Core 未返回该指令的证据。"),
    "The Core reported a publish without a command id. Verify with Core evidence.": _both(
        "", "Core รายงานการส่งโดยไม่มีรหัสคำสั่ง โปรดตรวจสอบกับหลักฐานจาก Core", "Core 报告已发布但没有指令 ID。请对照 Core 证据核实。"),
    "The Core may have acted but no bounded answer arrived. Never retried automatically.": _both(
        "", "Core อาจดำเนินการไปแล้วแต่ไม่ได้รับคำตอบ ระบบไม่ลองส่งซ้ำอัตโนมัติ", "Core 可能已执行，但未收到有效应答。不会自动重试。"),
    "The result was lost. The CUT may or may not have happened. Do NOT assume either; check Core evidence. It was not retried.": _both(
        "", "ผลลัพธ์สูญหาย CUT อาจเกิดขึ้นหรือไม่ก็ได้ อย่าสันนิษฐานทั้งสองทาง โปรดตรวจหลักฐานจาก Core ระบบไม่ได้ส่งซ้ำ",
        "结果丢失。CUT 可能发生也可能没有。请勿假定任何一种；请检查 Core 证据。未重试。"),
    "The result was lost. The RESTORE may or may not have happened. Do NOT run it again; check Core evidence.": _both(
        "", "ผลลัพธ์สูญหาย RESTORE อาจเกิดขึ้นหรือไม่ก็ได้ อย่าสั่งซ้ำ โปรดตรวจหลักฐานจาก Core", "结果丢失。RESTORE 可能发生也可能没有。请勿再次执行；请检查 Core 证据。"),
}

# Reasons that appear before " Nothing was sent." (or alone) from the local pre-checks and channel errors.
PHRASES = {
    "A reason is required.": _both("", "ต้องระบุเหตุผล", "必须填写原因。"),
    "the Core CUT channel is unavailable": _both("", "ช่องทาง CUT ของ Core ใช้งานไม่ได้", "Core 的 CUT 通道不可用"),
    "the Core RESTORE channel is unavailable": _both("", "ช่องทาง RESTORE ของ Core ใช้งานไม่ได้", "Core 的 RESTORE 通道不可用"),
    "the Core account cannot be resolved": _both("", "ระบุบัญชีของ Core ไม่ได้", "无法解析 Core 账户"),
    "the Core returned an invalid result": _both("", "Core ส่งผลลัพธ์ที่ไม่ถูกต้อง", "Core 返回了无效结果"),
    "the Core returned no bounded result": _both("", "Core ไม่ส่งผลลัพธ์ที่อยู่ในขอบเขต", "Core 未返回有效结果"),
    "the CUT server is not the Core account": _both("", "เซิร์ฟเวอร์ CUT ไม่ใช่บัญชีของ Core", "CUT 服务器不是 Core 账户"),
    "the RESTORE server is not the Core account": _both("", "เซิร์ฟเวอร์ RESTORE ไม่ใช่บัญชีของ Core", "RESTORE 服务器不是 Core 账户"),
}

# Sentences with a variable part: (pattern, {language: template}); the groups fill {1}, {2}, ...
PATTERNS = (
    (re.compile(r"^The device REJECTED the (CUT|RESTORE) \((.*)\)\. The network was NOT (?:cut|restored) by this command\.$"),
     {"th": "อุปกรณ์ปฏิเสธ {1} ({2}) เครือข่ายไม่ได้ถูกเปลี่ยนสถานะด้วยคำสั่งนี้", "zh": "设备拒绝了 {1}（{2}）。该指令未改变网络状态。"}),
    (re.compile(r"^No device ACK/STATUS within (\d+) s\. The outcome is unknown; the (CUT|RESTORE) was NOT retried\.(?: Physical state is NOT proven\.)?$"),
     {"th": "ไม่มี ACK/STATUS จากอุปกรณ์ภายใน {1} วินาที ไม่ทราบผลลัพธ์ และไม่ได้ส่ง {2} ซ้ำ",
      "zh": "{1} 秒内未收到设备 ACK/STATUS。结果未知；{2} 未重试。"}),
    (re.compile(r"^The Core answered (\S+)\. Verify with Core evidence\.$"),
     {"th": "Core ตอบ {1} โปรดตรวจสอบกับหลักฐานจาก Core", "zh": "Core 的应答为 {1}。请对照 Core 证据核实。"}),
    (re.compile(r"^Unrecognized ACK evidence \((.*)\)\. Do not assume the (CUT|RESTORE) happened\.$"),
     {"th": "ไม่รู้จักหลักฐาน ACK ({1}) อย่าสันนิษฐานว่า {2} เกิดขึ้นแล้ว", "zh": "无法识别的 ACK 证据（{1}）。请勿假定 {2} 已发生。"}),
    (re.compile(r"^The reason must be (\d+)-(\d+) printable characters\. Nothing was sent\.$"),
     {"th": "เหตุผลต้องมี {1}-{2} ตัวอักษรที่พิมพ์ได้ " + _NS["th"], "zh": "原因必须为 {1}-{2} 个可打印字符。" + _NS["zh"]}),
)


def text(key: str, language: str, **kwargs) -> str:
    entry = CONTROL_STRINGS[key]
    return entry.get(language, entry["en"]).format(**kwargs)


def flow_text(english, language: str) -> str:
    """The sentence in ``language``; English (unchanged) for ``en``, for an unknown sentence, and for anything that is not a string."""
    if language not in ("th", "zh") or not isinstance(english, str):
        return english
    entry = FLOW_TEXTS.get(english)
    if entry is not None:
        return entry[language]
    for pattern, templates in PATTERNS:
        match = pattern.match(english)
        if match:
            result = templates[language]
            for index, group in enumerate(match.groups(), 1):
                result = result.replace("{" + str(index) + "}", group)
            return result
    for phrase, entry in PHRASES.items():
        if english == phrase:
            return entry[language]
        if english == phrase.rstrip(".") + ". Nothing was sent.":
            joiner = " " if language == "th" else ("" if entry[language].endswith("。") else "。")
            return entry[language] + joiner + _NS[language]
    return english


def notice(title: str, body: str, language: str) -> tuple[str, str]:
    """A message-box ``(title, body)`` in ``language``. A body of the form ``STATE\\n\\nsentence`` keeps its state code."""
    if language not in ("th", "zh"):
        return title, body
    titles = {"Manual CUT": text("dialog.cut_title", language), "RESTORE": text("dialog.restore_title", language)}
    shown_title = titles.get(title, title)
    state, separator, sentence = body.partition("\n\n")
    if separator:
        return shown_title, f"{state}\n\n{flow_text(sentence, language)}"
    known = {
        "Confirmation did not match. Nothing was sent.": "notice.confirm_mismatch",
        "Authentication is required. Nothing was sent.": "notice.auth_required",
        "The RESTORE secret is required. Nothing was sent.": "notice.restore_secret_required",
    }
    if body in known:
        return shown_title, text(known[body], language)
    return shown_title, flow_text(body, language)
