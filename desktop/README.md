# telecord — shell Electron

Empacota o app web já em produção (`https://telecord.vercel.app`) num
executável nativo. **Não** contém o front: a página é carregada em runtime
da URL de produção, exatamente como um navegador faria. Atualizar o app web
(deploy normal na Vercel) já basta — não precisa gerar instalador novo para
isso.

Só é preciso relançar este shell quando muda algo do PRÓPRIO shell: preload,
permissões concedidas, integração nativa (tray, atalho global, deep link).

## Rodar em desenvolvimento

```
cd desktop
npm install
npm run dev
```

Abre a janela carregando `PROD_URL` de verdade — não há servidor local
nenhum para rodar antes. O auto-updater fica desabilitado automaticamente
em dev (`app.isPackaged === false`).

## Gerar um instalador local

```
npm run dist:win     # NSIS (.exe), Windows
npm run dist:mac      # .dmg, macOS
npm run dist:linux    # AppImage + .deb, Linux
```

Cada comando compila o TypeScript, copia os assets estáticos
(`offline.html`, `picker.html`) e roda o `electron-builder` para a
plataforma escolhida — o resultado fica em `desktop/release/`.

Sem os secrets de assinatura configurados (ver abaixo), o artefato sai
**não assinado**: no Windows o SmartScreen mostra aviso de editor
desconhecido; no macOS o Gatekeeper bloqueia a abertura até a pessoa liberar
manualmente (clique direito → Abrir, ou `xattr -d com.apple.quarantine`).

## Publicar um release

1. Suba a versão em `desktop/package.json` (`"version"`).
2. Crie e envie uma tag `desktop-vX.Y.Z`:
   ```
   git tag desktop-v1.0.0
   git push origin desktop-v1.0.0
   ```
3. O workflow `.github/workflows/desktop-release.yml` builda nas três
   plataformas (matriz windows/macos/ubuntu) e publica os artefatos como
   assets do GitHub Release correspondente à tag — é esse release que o
   `electron-updater` já instalado consulta para checar atualização.

Publicação manual (fora do CI), a partir de uma máquina com as credenciais
do GitHub configuradas (`GH_TOKEN` no ambiente):

```
npm run release
```

## O que precisa ser assinado, por plataforma

| Plataforma | O que assinar | Secrets |
|---|---|---|
| Windows | O `.exe` do instalador NSIS, com um certificado de assinatura de código (`.pfx`/`.p12`) | `CSC_LINK` (URL ou base64 do certificado), `CSC_KEY_PASSWORD` |
| macOS | O `.app`/`.dmg`, com um certificado "Developer ID Application" da Apple, **e** notarização (obrigatória desde o macOS Catalina para rodar sem aviso) | `CSC_LINK`, `CSC_KEY_PASSWORD` (certificado), `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` (notarização) |
| Linux | AppImage/deb não têm um mecanismo de assinatura de código equivalente no ecossistema Linux — nenhum secret é necessário | — |

O workflow já lê esses secrets condicionalmente: se estiverem ausentes, o
`electron-builder` simplesmente não assina e o build continua, produzindo
um artefato não assinado (útil enquanto não há certificado configurado).

### Onde conseguir os certificados

- **Windows**: uma autoridade certificadora comercial (DigiCert, Sectigo,
  etc.) ou um certificado de assinatura de código EV — o `.pfx` vai em
  `CSC_LINK` (pode ser um caminho `file://` no runner ou uma URL https, ou
  o próprio arquivo em base64 com o prefixo `data:...;base64,`).
- **macOS**: precisa de uma conta Apple Developer Program (paga), gerar um
  certificado "Developer ID Application" no `developer.apple.com`, e uma
  senha de app específica (`APPLE_APP_SPECIFIC_PASSWORD`, gerada em
  `appleid.apple.com` → Segurança → Senhas específicas de app) para a
  notarização via `notarytool`.

## Ícones

`build/icon.png` (512×512), `build/icon.ico` e `build/icon.icns` neste
repositório são **placeholders gerados programaticamente** (um quadrado
sólido na cor de acento do app) — substitua pelos ícones finais antes de
publicar para o público. Ferramentas comuns para gerar o conjunto completo
a partir de uma arte única: [electron-icon-builder](https://www.npmjs.com/package/electron-icon-builder)
ou, no macOS, `iconutil` (nativo) a partir de um `.iconset`.

## Como o front detecta o shell

O bridge só existe quando o app roda dentro deste shell — no navegador
comum, `window.telecord` é `undefined` e tudo se comporta como hoje.

```ts
if (window.telecord?.shellVersion) {
  console.log(`Rodando no shell telecord v${window.telecord.shellVersion}`);
}

// Esconder um toggle de "compartilhar som do sistema", por exemplo:
const canShareSystemAudio = window.telecord?.canCaptureSystemAudio ?? true;
```

No app real (`apps/web`), isso já está integrado em
`apps/web/src/lib/shell.ts` (`canCaptureSystemAudio()`) e usado em
`apps/web/src/lib/media.ts` (`screenShareCaptureOptions`) para não pedir
áudio de sistema quando o shell roda no macOS, onde a captura de loopback
não existe.

## Arquitetura de atualização — duas camadas independentes

1. **Front** (`apps/web`, publicado na Vercel): atualiza sozinho a cada
   deploy. A janela do shell só carrega a URL — um novo deploy do site já
   está disponível na próxima vez que alguém abrir o app ou recarregar.
2. **Shell** (este pacote): atualizado via `electron-updater`, apontando
   para os Releases deste repositório no GitHub. Baixa em segundo plano,
   avisa a pessoa e instala sozinho na próxima vez que o app fechar —
   nunca força um reinício no meio de uma chamada.

## Gerar instalador Windows numa máquina Windows sem privilégio de admin

O `electron-builder` baixa um pacote de ferramentas de assinatura
(`winCodeSign`) que contém binários macOS com symlinks — extraí-lo falha com
`Cannot create symbolic link : O cliente não tem o privilégio necessário`
se a conta não tiver o "Developer Mode" do Windows ativado (Configurações →
Sistema → Para desenvolvedores) ou não estiver rodando como Administrador.
Isso é uma limitação do ambiente local, não do projeto — nos runners do
GitHub Actions (`windows-latest`) isso já vem configurado e o build
funciona normalmente.

## Limitações conhecidas

- **Push-to-talk** usa `globalShortcut` do próprio Electron (sem
  dependência nativa extra, por restrição de projeto) — como essa API só
  avisa o `keydown` (inclusive as repetições automáticas do SO enquanto a
  tecla continua pressionada), o "soltar" é inferido por um timeout curto
  sem repetição, não um evento de `keyup` real. Na prática, imperceptível.
- **Captura de áudio do sistema** ao compartilhar tela só funciona no
  Windows (`audio: 'loopback'`). No macOS, exigiria um driver de áudio
  virtual externo que este shell não instala — o toggle correspondente já
  fica escondido no front (`canCaptureSystemAudio`).
