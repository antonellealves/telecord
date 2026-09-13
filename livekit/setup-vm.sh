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

# VM.Standard.E2.1.Micro tem só ~498MB de RAM REAL utilizável (não 1GB —
# a shape reporta 1GB mas o kernel só enxerga ~500MB). `dnf` sozinho já
# empurra isso ao limite ao resolver dependências; sem swap de sobra, o
# processo trava em I/O (thrashing) por dezenas de minutos em vez de morrer
# rápido. O swap entra ANTES de qualquer dnf/yum, não depois — é o que faz
# a diferença entre a instalação terminar em minutos ou nunca terminar.
if ! swapon --show | grep -q swapfile2 && [ ! -f /swapfile2 ]; then
  echo "==> Criando 3GB de swap adicional (a VM já vem com ~500MB de swap padrão da Oracle, mas não basta)"
  sudo fallocate -l 3G /swapfile2
  sudo chmod 600 /swapfile2
  sudo mkswap /swapfile2
  sudo swapon /swapfile2
  echo '/swapfile2 none swap sw 0 0' | sudo tee -a /etc/fstab
fi
free -h

echo "==> Instalando Docker"
# NÃO use "dnf install dnf-utils" nem o repo .../linux/rhel/... — os dois já
# travaram por 30+ minutos numa instalação real nesta mesma shape, sem
# terminar. yum-utils (equivalente ao dnf-utils em Oracle Linux) geralmente
# já vem pré-instalado na imagem, e o repositório CENTOS (não rhel) do
# Docker é o testado e compatível com Oracle Linux 9. As flags abaixo
# evitam gastar memória com metadados/docs desnecessários.
sudo yum install -y yum-utils --setopt=install_weak_deps=False --setopt=tsflags=nodocs \
  --disablerepo=ol9_ksplice --disablerepo=ol9_oci_included
sudo yum-config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
sudo yum install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin \
  --setopt=install_weak_deps=False --setopt=tsflags=nodocs \
  --disablerepo=ol9_ksplice --disablerepo=ol9_oci_included

# CRÍTICO nesta VM: por padrão o Docker cria um processo `docker-proxy`
# PARA CADA PORTA publicada. A faixa de mídia (50000-50100/udp) sozinha são
# 101 portas — 101 processos, mais os de 7880/7881, o suficiente para
# consumir toda a RAM+swap e travar a VM por completo (foi exatamente o que
# aconteceu no primeiro deploy real). Com `userland-proxy: false`, o próprio
# kernel roteia via iptables/nft, sem processo nenhum por porta.
echo '{"userland-proxy": false}' | sudo tee /etc/docker/daemon.json
sudo systemctl enable --now docker
sudo systemctl restart docker
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
   LIVEKIT_VM_HOST, LIVEKIT_VM_USER, LIVEKIT_VM_SSH_KEY, LIVEKIT_PUBLIC_HOST.

Depois disso, todo push em main que tocar em livekit/ faz o deploy sozinho.
EOF
