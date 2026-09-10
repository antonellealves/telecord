# Sons do soundboard

Largue arquivos de áudio nesta pasta. Não há lista para editar: o catálogo em
`apps/web/src/lib/sounds.ts` é montado a partir daqui no build.

- **O nome do arquivo vira o rótulo.** `olha-a-maconha.mp3` aparece como
  "Olha a maconha". Acentos e maiúsculas valem no nome — o identificador
  interno é derivado e sanitizado sozinho.
- **O emoji do card é sorteado.** Sai do nome do arquivo, então é sempre o
  mesmo para todo mundo, e dois sons não repetem símbolo. Renomear o arquivo
  troca o emoji.
- **Formatos aceitos:** mp3, ogg, oga, opus, wav, m4a, aac, flac, webm.
- **Prefira arquivos curtos** (poucos segundos, algumas centenas de KB). Todo
  mundo baixa todos eles junto com o app.
- **Todos precisam estar na mesma versão.** O áudio não trafega pela sala: quem
  clica manda só um aviso e cada cliente toca o próprio arquivo. Quem estiver com
  uma versão antiga aberta não vai ter o som novo até recarregar.

Sobre o que você coloca aqui: esta pasta é versionada num repositório público
que faz deploy sozinho, então qualquer arquivo aqui passa a ser distribuído
publicamente, não só tocado entre vocês. Vale conferir se o clipe pode ser
redistribuído — ou deixar o repositório privado.
