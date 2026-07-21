import time
import datetime
import subprocess
import re
import sys

def parse_reset_time(text):
    """
    Parses reset time from text formats such as:
    - "You've hit your session limit · resets 5:10pm (Asia/Bangkok)"
    - "resets 1am (Asia/Bangkok)"
    - "5:10pm" or "1am" or "17:10"
    """
    if not text:
        return None
        
    text = text.strip()
    
    # Try 12-hour format with am/pm (e.g., resets 5:10pm or resets 1am or 5:10pm)
    match = re.search(r'resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)', text, re.IGNORECASE)
    if not match:
        match = re.search(r'(\d{1,2})(?::(\d{2}))?\s*(am|pm)', text, re.IGNORECASE)
        
    if match:
        hour = int(match.group(1))
        minute = int(match.group(2)) if match.group(2) else 0
        ampm = match.group(3).lower()
        
        if ampm == 'pm' and hour < 12:
            hour += 12
        elif ampm == 'am' and hour == 12:
            hour = 0
            
        now = datetime.datetime.now()
        target = now.replace(hour=hour, minute=minute, second=5, microsecond=0)
        if target <= now:
            target += datetime.timedelta(days=1)
        return target

    # Try 24-hour format (e.g., 17:10 or 05:10)
    match_24 = re.search(r'(\d{1,2}):(\d{2})', text)
    if match_24:
        hour = int(match_24.group(1))
        minute = int(match_24.group(2))
        now = datetime.datetime.now()
        target = now.replace(hour=hour, minute=minute, second=5, microsecond=0)
        if target <= now:
            target += datetime.timedelta(days=1)
        return target

    return None

def get_clipboard_text():
    try:
        res = subprocess.run(["powershell", "-NoProfile", "-Command", "Get-Clipboard"], capture_output=True, text=True, timeout=3)
        return res.stdout.strip()
    except Exception:
        return ""

def send_continue_command():
    print("\n>>> 🔔 Reset time reached! Sending 'continue' command to Claude Code...")
    time.sleep(2)

    ps_script = """
    $wshell = New-Object -ComObject WScript.Shell
    
    # Try activating common window titles
    $targets = @("AEGIS", "Claude", "Visual Studio Code", "Terminal", "PowerShell", "cmd")
    foreach ($t in $targets) {
        if ($wshell.AppActivate($t)) {
            Write-Host "Activated window containing: $t"
            Start-Sleep -Milliseconds 500
            break
        }
    }

    # Send 'continue' and ENTER
    $wshell.SendKeys('continue')
    Start-Sleep -Milliseconds 500
    $wshell.SendKeys('~')
    Start-Sleep -Seconds 3

    # Send an extra ENTER just in case
    $wshell.SendKeys('~')
    """

    try:
        subprocess.run(["powershell", "-NoProfile", "-Command", ps_script], check=True)
        print(">>> ✅ Successfully typed 'continue' and sent ENTER to Claude Code!")
    except Exception as e:
        print(f">>> ❌ Error sending command: {e}")

    try:
        import winsound
        winsound.Beep(1000, 800)
    except Exception:
        pass

def countdown_until(target_time):
    print(f"\n------------------------------------------------------------------")
    print(f" ⏳ Target Reset Time : {target_time.strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"------------------------------------------------------------------")

    try:
        while True:
            now = datetime.datetime.now()
            remaining = (target_time - now).total_seconds()
            if remaining <= 0:
                break
            
            hours, remainder = divmod(int(remaining), 3600)
            minutes, seconds = divmod(remainder, 60)
            print(f"\r⏳ Time remaining until reset: {hours:02d}h {minutes:02d}m {seconds:02d}s ", end="", flush=True)
            time.sleep(1)
        print()
    except KeyboardInterrupt:
        print("\n\n⚠️ Countdown paused/cancelled by user.")
        raise

def main():
    print("==================================================================")
    print("   AEGIS System - Dynamic Claude Code Auto-Continue Scheduler")
    print("==================================================================")
    print(f" Current Local Time : {datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print("------------------------------------------------------------------")
    print(" Feature Highlights:")
    print(" - Automatic detection of reset time (e.g. 'resets 5:10pm', 'resets 1am')")
    print(" - Auto-Scanner for Windows Clipboard (Copy error line with Ctrl+C)")
    print(" - Manual time entry supported ('5:10pm', '1am', '17:10')")
    print("==================================================================\n")

    round_count = 1

    while True:
        target_time = None
        print(f"\n--- [Round {round_count}] ---")
        
        # Check if clipboard currently has valid reset text
        clip_text = get_clipboard_text()
        parsed = parse_reset_time(clip_text)
        
        if parsed:
            print(f"📋 Detected reset time in Clipboard: '{clip_text}'")
            print(f"   Calculated Reset Target : {parsed.strftime('%Y-%m-%d %H:%M:%S')}")
            use_clip = input("Do you want to use this time? [Y/n]: ").strip().lower()
            if use_clip in ['', 'y', 'yes']:
                target_time = parsed

        if not target_time:
            print("\nOptions:")
            print(" 1. Type or Paste reset time (e.g., '5:10pm', '1am', '17:10', or paste 'resets 5:10pm')")
            print(" 2. Press ENTER to start Clipboard Auto-Scanner (Auto-detects when you copy text)")
            user_input = input("\nEnter input or press ENTER for Auto-Scan: ").strip()

            if user_input:
                target_time = parse_reset_time(user_input)
                if not target_time:
                    print("❌ Could not parse time format. Please use e.g. '5:10pm', '1am', '17:10' or paste full text.")
                    continue
            else:
                print("\n🔍 Clipboard Auto-Scanner active! Highlight and Copy (Ctrl+C) the limit message in Terminal...")
                last_clip = get_clipboard_text()
                try:
                    while not target_time:
                        current_clip = get_clipboard_text()
                        if current_clip != last_clip:
                            last_clip = current_clip
                            target_time = parse_reset_time(current_clip)
                            if target_time:
                                print(f"\n📋 Auto-detected reset time from Clipboard: '{current_clip}'")
                                print(f"   Calculated Reset Target : {target_time.strftime('%Y-%m-%d %H:%M:%S')}")
                                break
                        time.sleep(1)
                except KeyboardInterrupt:
                    print("\nAuto-scan cancelled.")
                    break

        if target_time:
            try:
                countdown_until(target_time)
                send_continue_command()
                print(f"\n✅ Round {round_count} finished at {datetime.datetime.now().strftime('%H:%M:%S')}!")
                round_count += 1
            except KeyboardInterrupt:
                pass

        cont = input("\nDo you want to setup another round for the next limit reset? [Y/n]: ").strip().lower()
        if cont in ['n', 'no']:
            print("Exiting scheduler.")
            break

if __name__ == "__main__":
    main()
