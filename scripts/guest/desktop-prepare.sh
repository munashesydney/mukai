#!/bin/sh
set -eu
modprobe qemu_fw_cfg
install -d -o mukai -g mukai -m 0700 /run/mukai-desktop
/usr/local/bin/node -e 'const fs=require("node:fs");const token=fs.readFileSync("/sys/firmware/qemu_fw_cfg/by_name/opt/com.mukai/token/raw","utf8").trim();if(!/^[a-f0-9]{64}$/.test(token))process.exit(1);console.log(Buffer.from(token,"hex").toString("base64").slice(0,8))' | tigervncpasswd -f > /run/mukai-desktop/passwd
chown mukai:mukai /run/mukai-desktop/passwd
chmod 0600 /run/mukai-desktop/passwd
