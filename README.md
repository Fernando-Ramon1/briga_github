# Briga — painel BLE de configuração e debug

Este repositório contém somente o site que acompanha a entrega **BRIGA_GERAL_BLE_DEBUG** e sua revisão de comentários **BRIGA_GERAL_BLE_DEBUG_EQUIPE**. O firmware do ESP32 não foi colocado aqui. As duas versões usam o mesmo protocolo e a mesma lógica.

## Acessar o painel

**https://fernando-ramon1.github.io/briga_github/**

Abra o endereço em um navegador com Web Bluetooth, como Chrome no Android ou em um computador compatível, com o Bluetooth ligado. Clique em **Conectar ao robô** e escolha o Briga.

O ESP32 precisa estar com o firmware BLE correspondente, no modo Auto. A página verifica o protocolo `BRIGA_BLE_1`; não se conecta ao firmware antigo que usa apenas SerialBT nem ao protocolo original do SDK.

Escolha abertura, lado, bandeira e a opção de debug. Clique em **Aplicar configuração** e aguarde a confirmação de aplicação na placa. A largada e a parada continuam pelo controle infravermelho.

**Faça o primeiro teste com as rodas suspensas. Fechar a página ou perder a conexão Bluetooth não para os motores.** Com debug ligado, a parada pelo IR bloqueia novos movimentos e preserva o histórico enquanto a placa permanecer ligada. Exporte o CSV antes de reiniciar o ESP32 ou fechar/recarregar a página.

O botão 3 também funciona antes da largada: com debug ligado, bloqueia sem reiniciar; sem debug, para e reinicia a placa. Retomar a captura não rearma o robô depois do STOP.

A publicação do site não valida a compilação do firmware, o Bluetooth físico, o controle PS4 ou os atuadores. Esses testes ainda precisam ser feitos no hardware.

## Arquivos

- `index.html`: interface do painel.
- `estilo.css`: apresentação e adaptação para celular.
- `briga.js`: conexão BLE, configuração, sensores, histórico, filtros e exportação.
- `.nojekyll`: marcador para publicação estática.

Os três arquivos correspondem à pasta `site/` do pacote para a equipe. Os comentários de estudo por linha foram substituídos por explicações pontuais dos blocos. Essa revisão não alterou instruções, protocolo, aparência ou comportamento do painel.

O GitHub entrega os arquivos da página. Os comandos e os registros do robô circulam diretamente entre o navegador e o ESP32 por BLE; este painel não envia os logs para um servidor externo.

## Publicação no GitHub Pages

A publicação usa os arquivos da raiz da branch `main`, sem instalar ferramentas nem criar um workflow personalizado.

Para reproduzir a configuração em outro repositório:

1. Abra **Settings → Pages**.
2. Em **Build and deployment**, escolha **Source: Deploy from a branch**.
3. Selecione a branch **main** e a pasta **/ (root)**.
4. Clique em **Save** e aguarde o GitHub indicar que a publicação terminou.

O estado de cada publicação aparece em Settings → Pages e em Actions. O arquivo vazio `.nojekyll` mantém a publicação como arquivos estáticos. Atualizações dos arquivos em `main` são publicadas pelo GitHub Pages.

## Referências

- [Configurar a fonte de publicação do GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)
- [Criar um site e desativar o processamento Jekyll](https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-github-pages-site)
- [Web Bluetooth no Chrome](https://developer.chrome.com/docs/capabilities/bluetooth)
