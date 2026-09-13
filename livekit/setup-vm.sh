#!/usr/bin/env bash
# Preparação ÚNICA da VM Oracle (Oracle Linux 9), rodada manualmente uma vez
# por SSH antes do primeiro deploy. O workflow do GitHub Actions (ver
# .github/workflows/deploy.yml) só faz deploys incrementais depois disso —
# ele não instala nada na máquina.
#
# Uso:
#   scp livekit/setup-vm.sh opc@<ip-da-vm>:~/
#   ssh opc@<ip-da-vm> "chmod +x setup-vm.sh && ./setup-vm.sh"
set -euo pipefail

echo "==> Instalando Docker (repositório oficial)"
sudo dnf install -y dnf-utils
sudo dnf config-manager --add-repo https://download.docker.com/linux/rhel/docker-ce.repo
sudo dnf install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"

echo "==> Abrindo portas no firewall local (firewalld)"
# 22 (SSH) já vem aberta. As demais são as que o LiveKit e o Caddy precisam:
#   80/443   — Caddy (TLS automático + handshake HTTP inicial)
#   7881     — TCP fallback do ICE
#   50000-50100/udp — mídia (RTC)
# Note que 7880 (LiveKit HTTP interno) NÃO é aberta: só o Caddy fala com ela,
# via rede interna do Docker Compose.
sudo firewall-cmd --permanent --add-port=80/tcp
sudo firewall-cmd --permanent --add-port=443/tcp
sudo firewall-cmd --permanent --add-port=443/udp
sudo firewall-cmd --permanent --add-port=7881/tcp
sudo firewall-cmd --permanent --add-port=50000-50100/udp
sudo firewall-cmd --reload

echo "==> Criando diretório de deploy"
sudo mkdir -p /opt/telecord-livekit
sudo chown "$USER":"$USER" /opt/telecord-livekit

# VM.Standard.E2.1.Micro tem só 1GB de RAM. Docker + LiveKit + Caddy cabem,
# mas sem folga nenhuma — o OOM killer derruba o processo errado na primeira
# sala com mais de um ou dois participantes sem isto. 2GB de swap em disco é
# mais lento que RAM de verdade, mas evita o processo morrer; a Oracle Free
# Tier já dá bastante espaço de bloco de sobra para isso.
if [ ! -f /swapfile ]; then
  echo "==> Criando 2GB de swap (RAM da VM é só 1GB)"
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
fi

cat <<'EOF'

Falta ainda, à mão, antes do primeiro deploy:

1. No CONSOLE ORACLE (não nesta VM): o Security List / Network Security Group
   da sub-rede também bloqueia por padrão. Libere as MESMAS portas de cima
   (80, 443 tcp+udp, 7881 tcp, 50000-50100 udp) nas regras de Ingress —
   sem isso o firewalld interno não é suficiente, a nuvem barra antes de
   chegar na VM.

2. Copie livekit/.env.example para /opt/telecord-livekit/.env e preencha:
   LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_WEBHOOK_URL, LIVEKIT_NODE_IP
   (IP público desta VM) e LIVEKIT_PUBLIC_HOST (ex.: 129-1-2-3.nip.io).

3. Saia e entre de novo por SSH (ou rode `newgrp docker`) para o grupo
   `docker` recém-adicionado valer nesta sessão.

4. Configure os secrets do GitHub Actions (ver .github/workflows/deploy.yml):
   LIVEKIT_VM_HOST, LIVEKIT_VM_USER, LIVEKIT_VM_SSH_KEY.

Depois disso, todo push em main que tocar em livekit/ faz o deploy sozinho.
EOF
