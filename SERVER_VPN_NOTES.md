# Сервер как SSH VPN: что уже настроено

## Что делали

- Подняли SSH и проверили, что сервис запущен и активен.
- В `sshd_config` включили доступ по логину/паролю для отдельного пользователя `vpnuser`.
- Ограничили вход root по SSH: `PermitRootLogin no`.
- Включили TCP-forwarding для SSH-туннеля.
- Настроили UFW: разрешен вход на `22/tcp`, входящий трафик по умолчанию `deny`, исходящий `allow`.

## Рабочие параметры SSH (итог)

В `/etc/ssh/sshd_config` должны быть строки:

```conf
PermitRootLogin no
PasswordAuthentication yes
ChallengeResponseAuthentication no
UsePAM yes
AllowUsers vpnuser
AllowTcpForwarding yes
PermitTunnel yes
GatewayPorts no
X11Forwarding no
ClientAliveInterval 300
ClientAliveCountMax 2
```

После изменений применяли:

```bash
sshd -t
systemctl restart ssh
systemctl status ssh --no-pager
```

## Пользователь для подключения

- Пользователь: `vpnuser`
- Пароль для `vpnuser` установлен командой `passwd vpnuser`.
- Подключаться нужно именно этим пользователем, не `root`.

## UFW (итог)

Проверка показывала:

- `Status: active`
- `Default: deny (incoming), allow (outgoing), deny (routed)`
- Разрешено: `22/tcp ALLOW IN` (IPv4/IPv6)

Полезные команды:

```bash
ufw status verbose
ufw allow 22/tcp
ufw reload
```

## Что осталось проверить

1. `fail2ban` установлен, но сервис падал на старте (конфиг не доведен до конца).
2. В клиенте (Amnezia) нужно выбрать именно режим SSH/SOCKS (не просто SSH-сессия).
3. Включить проксирование DNS через туннель в клиенте, иначе сайты могут не открываться.
4. Проверить исходящий интернет с сервера:

```bash
curl -I https://google.com
```

## Если туннель подключается, но сайты не открываются

Частые причины:

- в клиенте не включен режим «весь трафик через туннель»;
- DNS не идет через туннель;
- используется не тот профиль (SSH вместо SSH SOCKS);
- ограничения сети оператора/маршрутизации.

## Минимальный чеклист перед использованием

```bash
# Проверить SSH
sshd -t && systemctl status ssh --no-pager

# Проверить UFW
ufw status verbose

# Проверить исходящий интернет с сервера
curl -I https://google.com
```

## Важно по безопасности

- Токены/пароли, которые публиковались в чатах и на скринах, считать скомпрометированными и сменить.
- По возможности перейти с входа по паролю на вход по SSH-ключу.
- После перехода на ключи отключить `PasswordAuthentication`.
