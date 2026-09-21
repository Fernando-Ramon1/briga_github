'use strict'; //=> Detecta erros de variaveis em vez de criar nomes globais por engano.
const servicoBriga = '0000ff10-0000-1000-8000-00805f9b34fb'; //=> Mesmo servico BLE reaproveitado do SDK.
const caracteristicaBriga = '0000ff11-0000-1000-8000-00805f9b34fb'; //=> Mesmo modelo WRITE seguido de READ do SDK, com protocolo Briga validado no handshake.
const nomesEstados = ['BUSCAR', 'ALINHAR_FRENTE', 'ESPERAR_ALVO', 'AVANCAR_LENTO', 'VIRAR_LATERAL_E', 'VIRAR_LATERAL_D', 'ATAQUE_RAPIDO']; //=> Espelha o enum original, sem enum class nem canal generico do SDK.
const nomesTipos = ['ESTADO', 'MOTOR', 'INÍCIO LINHA', 'ETAPA LINHA', 'FIM LINHA', 'FASE', 'MARCA']; //=> Traduz os tipos do RegistroDebug para leitura humana.
let dispositivo = null; //=> Guarda somente o dispositivo escolhido conscientemente pelo operador.
let caracteristica = null; //=> Nao faz buscas ou reconexoes ocultas durante as consultas.
let filaBluetooth = Promise.resolve(); //=> Como no SDK, serializa cada par escrita/leitura para nao embaralhar respostas.
let geracaoConexao = 0; //=> Invalida pedidos antigos quando o operador troca ou perde a conexao.
let monitorando = false; //=> Controla as consultas; nao controla a gravacao no ESP32.
let consultando = false; //=> Impede acumular novas rodadas se o Bluetooth estiver demorando.
let temporizador = null; //=> Permite parar as consultas sem fechar a pagina ou apagar eventos.
let resumoAtual = null; //=> Guarda o ultimo quadro recebido, acompanhado da idade local.
let quadroSensores = null; //=> Mantem a ultima resposta de sensores separada do historico.
let recebidoEm = 0; //=> Instante local em que chegou o resumo, nao usado para medir duracoes taticas.
let sessao = null; //=> Identifica o boot remoto corrente.
let captura = null; //=> Identifica a captura remota corrente.
let cursor = 0; //=> Ultimo evento aceito; permite releitura e reconexao sem duplicar registros.
let registros = []; //=> Historico retido no navegador, com limite independente da memoria do ESP32.
let descartadosLocal = 0; //=> Torna explicita a perda por limite de memoria da pagina.
let faltantes = 0; //=> Conta lacunas observadas entre eventos, diferente das sobrescritas totais do ESP32.
let afastamentoPagina = 0; //=> Zero mostra os mais recentes; valores maiores permitem consultar o passado.
let salvando = false; //=> Evita dois cliques de configuracao antes de confirmar o primeiro.
let renderPendente = false; //=> Atualiza a tabela por rodada, nao redesenha a cada byte recebido.

function elemento(id) { return document.getElementById(id); } //=> Atalho pequeno apenas para encontrar elementos da pagina.
function mensagem(texto, erro = false) //=> Mostra sucesso ou falha sem fingir que um pedido recusado foi executado.
{ //=> Centraliza apenas a apresentacao da mensagem.
    elemento('mensagem').textContent = texto; //=> Texto remoto nunca e interpretado como HTML.
    elemento('mensagem').className = erro ? 'erro' : ''; //=> Destaca falhas de conexao, validacao e ACK.
} //=> Termina a mensagem da interface.
function nomeEstado(numero) { return nomesEstados[numero] || `ESTADO_${numero}`; } //=> Nao oculta um valor desconhecido recebido no protocolo.
function tempo(us) { return (us / 1000).toLocaleString('pt-BR', {maximumFractionDigits: 3}) + ' ms'; } //=> Mantem resolucao de microssegundos na apresentacao em milissegundos.

function pedir(bytes) //=> Adaptacao procedural da bleQueue do SDK: um pedido prepara a resposta do READ seguinte.
{ //=> A fila tambem organiza cliques enquanto o monitor esta consultando.
    const geracao = geracaoConexao; //=> Este pedido pertence somente a conexao em que foi criado.
    const executar = async () => //=> O trabalho real espera sua vez na mesma fila GATT.
    { //=> Trata uma transacao completa, nao uma escrita solta.
        const canal = caracteristica; //=> Mantem a referencia da mesma caracteristica ao longo do pedido.
        if (!canal || !dispositivo?.gatt?.connected || geracao !== geracaoConexao) throw new Error('Robô desconectado; clique em Conectar.'); //=> Nao abre seletor de Bluetooth a partir de um temporizador.
        await canal.writeValueWithResponse(bytes); //=> Aguarda a escrita que preparou a resposta no firmware.
        const dados = await canal.readValue(); //=> Le a resposta antes de deixar o proximo pedido escrever.
        if (geracao !== geracaoConexao) throw new Error('Resposta de uma conexão encerrada.'); //=> Nao aplica dados atrasados em outra conexao.
        const resposta = JSON.parse(new TextDecoder().decode(dados)); //=> Falha de JSON e erro real, nunca um objeto vazio interpretado como sucesso.
        if (!resposta || typeof resposta !== 'object' || resposta.erro) throw new Error(resposta?.erro || 'Resposta inválida.'); //=> O servidor pode recusar comandos ou cursores invalidos.
        return resposta; //=> Entrega os dados validados ao chamador.
    }; //=> Fecha uma transacao GATT.
    const resultado = filaBluetooth.then(executar, executar); //=> Mesmo que o pedido anterior falhe, este ainda espera sua vez.
    filaBluetooth = resultado.catch(() => {}); //=> A fila nao fica permanentemente rejeitada; o erro segue em resultado.
    return resultado; //=> Quem pediu decide como apresentar a falha.
} //=> Termina o transporte reaproveitado do SDK.

function guardar(registro) //=> Retem eventos recebidos e marcas de lacuna sem depender do que esta visivel.
{ //=> Limita memoria local sem descartar silenciosamente.
    registros.push(registro); //=> Adiciona apenas eventos novos ou marcas explicitas.
    if (registros.length > 10000) //=> A pagina nao promete historico ilimitado.
    { //=> Substitui o trecho mais antigo quando o limite local foi atingido.
        const excesso = registros.length - 10000; //=> Conta exatamente quantas entradas serao removidas.
        registros.splice(0, excesso); //=> Libera memoria das entradas locais mais antigas.
        descartadosLocal += excesso; //=> O CSV e a tela informam que houve descarte local.
    } //=> Termina o tratamento do limite local.
    renderPendente = true; //=> Adia o desenho ate terminar a rodada de consultas.
} //=> Termina a insercao no historico do navegador.

function aceitarResumo(resumo) //=> Identifica o firmware antes de habilitar qualquer configuracao.
{ //=> Valida o formato minimo e separa boots e capturas.
    if (resumo.protocolo !== 'BRIGA_BLE_1' || !Number.isInteger(resumo.sessao) || !Number.isInteger(resumo.captura) || !Number.isSafeInteger(resumo.us)) throw new Error('Este dispositivo não usa o protocolo desta página do Briga.'); //=> Mesmos UUIDs do SDK nao significam comandos compativeis.
    if (sessao !== resumo.sessao || captura !== resumo.captura) //=> Nao mistura tempos ou cursores de outro teste.
    { //=> Mantem as capturas antigas no navegador e inicia o cursor da nova.
        quadroSensores = null; //=> Nao apresenta sensores de um boot anterior como se fossem desta captura.
        elemento('sensores').textContent = 'Aguardando uma amostra desta sessão.'; //=> A proxima consulta confirma leituras novas.
        sessao = resumo.sessao; //=> Atualiza a identidade do boot remoto.
        captura = resumo.captura; //=> Atualiza a identidade da captura.
        cursor = 0; //=> Pede do primeiro evento ainda disponivel, detectando eventuais sobrescritas.
        guardar({sessao, captura, nota: `Sessão ${sessao}, captura ${captura}`}); //=> Marca a separacao entre ensaios no CSV e na tabela.
    } //=> Termina o reconhecimento de uma nova captura.
    resumoAtual = resumo; //=> Mantem o quadro atual sem transformar cada consulta em um log.
    recebidoEm = performance.now(); //=> Idade de comunicacao, separada do relogio de eventos do ESP32.
    atualizarQuadro(); //=> Mostra os dados e as permissoes confirmadas pelo firmware.
} //=> Termina o processamento da situacao atual.

function aceitarEvento(resposta) //=> Deduplica por numero sequencial e mostra lacunas reais.
{ //=> A resposta precisa pertencer a mesma captura da consulta.
    if (resposta.sessao !== sessao || resposta.captura !== captura) throw new Error('A sessão mudou; atualize a consulta.'); //=> Nao une um evento antigo a um novo boot.
    const evento = resposta.evento; //=> null significa que ja chegamos ao ultimo registro disponivel.
    if (evento === null) return false; //=> Encerra o lote desta rodada sem inventar um evento vazio.
    if (!evento || !Number.isInteger(evento.n) || evento.n < 1 || !Number.isSafeInteger(evento.us) || !Number.isSafeInteger(evento.dur) || !Number.isInteger(evento.tipo) || typeof evento.motivo !== 'string') throw new Error('Registro incompleto ou inválido.'); //=> Nao grava dados que nao possam ser interpretados.
    if (evento.n <= cursor) return true; //=> Reenviar uma pagina nao duplica eventos ja aceitos.
    if (evento.n > cursor + 1) //=> Detecta registros que desapareceram antes de chegar ao celular.
    { //=> Mantem uma marca visivel do trecho ausente.
        const quantidade = evento.n - cursor - 1; //=> Mede a lacuna a partir do cursor realmente recebido.
        faltantes += quantidade; //=> Nao confunde perdas reais com registros ja exportados e sobrescritos na placa.
        guardar({sessao, captura, nota: `LACUNA: ${quantidade} eventos não recebidos (${cursor + 1} a ${evento.n - 1})`}); //=> Mantem a advertencia tambem no CSV.
    } //=> Termina a identificacao de lacuna.
    guardar({sessao, captura, ...evento}); //=> Copia os campos e vincula a entrada a este teste.
    cursor = evento.n; //=> So avanca depois de guardar um evento valido.
    return true; //=> Pode haver mais eventos para pedir nesta rodada.
} //=> Termina o recebimento de um registro.

async function buscarEvento() //=> Usa um comando curto que cabe em uma escrita ATT padrao.
{ //=> Monta os mesmos quatro bytes por contador que o firmware espera.
    const pedido = new Uint8Array(13); //=> Um byte de comando e tres inteiros de quatro bytes.
    pedido[0] = 0x21; //=> Codigo acordado para consultar o proximo registro do debug.
    const numeros = new DataView(pedido.buffer); //=> Permite escrever contadores em little-endian explicitamente.
    numeros.setUint32(1, sessao, true); //=> Primeiro contador identifica o boot.
    numeros.setUint32(5, captura, true); //=> Segundo identifica a captura.
    numeros.setUint32(9, cursor, true); //=> Terceiro pede tudo depois do ultimo numero recebido.
    return aceitarEvento(await pedir(pedido)); //=> A fila Bluetooth impede troca da resposta com outra consulta.
} //=> Termina a consulta de um evento.

async function consultar() //=> Atualiza quadro e drena alguns eventos sem criar uma fila infinita de polling.
{ //=> Uma rodada so comeca quando a anterior terminou.
    if (!monitorando || consultando || !caracteristica) return; //=> Pausa ou conexao ausente nao gera pedidos extras.
    consultando = true; //=> Trava apenas outra rodada da interface.
    const geracao = geracaoConexao; //=> Uma rodada antiga nao pode agendar consultas dentro de outra conexao.
    try //=> Falhas nao devem manter a interface eternamente ocupada.
    { //=> Pede sempre o resumo antes de usar sua sessao e captura.
        aceitarResumo(await pedir(new Uint8Array([0x01]))); //=> Tambem confirma progresso do loop e configuracao aplicada.
        quadroSensores = await pedir(new Uint8Array([0x02])); //=> Nao pede que o firmware realize outra medicao de hardware.
        for (let i = 0; i < 8 && monitorando && cursor < resumoAtual.total; i++) //=> Limita o lote por rodada para os botoes continuarem responsivos.
        { //=> Recolhe acontecimentos gravados, nao amostras de estado do instante da consulta.
            if (!await buscarEvento()) break; //=> Para ao alcancar o ultimo registro disponivel.
        } //=> Termina o lote sem prometer acompanhar qualquer taxa de eventos.
        atualizarQuadro(); //=> Mostra a idade da ultima amostra e os contadores de perda.
        if (renderPendente && !elemento('pausarTela').checked && afastamentoPagina === 0) desenharHistorico(); //=> Nao desloca um trecho antigo que o operador esta lendo.
    } //=> Termina uma rodada bem sucedida.
    catch (erro) { if (geracao === geracaoConexao) mensagem(`Consulta interrompida: ${erro.message}. Os valores exibidos podem estar antigos.`, true); } //=> Erro nunca vira demonstracao ou leitura zero falsa.
    finally //=> Libera a rodada inclusive quando o radio falha.
    { //=> Agenda a proxima somente depois de terminar todas as operacoes atuais.
        if (geracao === geracaoConexao) //=> A finalizacao de uma conexao antiga nao altera a rodada nova.
        { //=> Libera somente a geracao que iniciou este monitor.
            consultando = false; //=> Permite uma proxima rodada da mesma conexao.
            if (monitorando) temporizador = setTimeout(consultar, 200); //=> Cadencia da exibicao, nao frequencia de captura do ESP32.
        } //=> Termina o reagendamento protegido contra reconexao.
    } //=> Termina o agendamento nao acumulativo.
} //=> Termina o monitor periodico.

function perdeuConexao() //=> Mantem o historico local mesmo se o radio cair.
{ //=> Nao executa comandos de motor nem interpreta desconexao como STOP.
    geracaoConexao++; //=> Respostas que ainda chegarem da conexao antiga sao descartadas.
    caracteristica = null; //=> Nao tenta reutilizar uma caracteristica encerrada.
    monitorando = false; //=> Evita erros repetidos de consulta em segundo plano.
    clearTimeout(temporizador); //=> Cancela a proxima rodada ainda nao iniciada.
    elemento('conexao').textContent = 'Desconectado — histórico local preservado'; //=> Nao deixa valores antigos parecerem uma conexao funcional.
    mensagem('Bluetooth desconectado. Isso não para o robô; use o controle IR.', true); //=> Mantem clara a separacao entre radio e parada.
    atualizarQuadro(); //=> Bloqueia os botoes remotos, mas mantem exportacao local disponivel.
} //=> Termina a notificacao de desconexao.

async function conectar() //=> Somente o clique do operador abre a escolha Web Bluetooth.
{ //=> Verifica o contexto antes de pedir acesso ao radio.
    if (!window.isSecureContext || !navigator.bluetooth) //=> Web Bluetooth nao esta disponivel em qualquer navegador/origem.
    { //=> Evita uma sequencia de erros sem explicar o requisito.
        mensagem('Use Chrome com Web Bluetooth em HTTPS ou http://localhost. No celular, publique a pasta site em HTTPS.', true); //=> HTTP pelo IP do computador nao substitui HTTPS no celular.
        return; //=> Nao prossegue com uma API inexistente.
    } //=> Termina a verificacao de ambiente.
    elemento('conectar').disabled = true; //=> Evita abrir varios seletores de dispositivo.
    try //=> Cancelar o seletor e falha de conexao sao apresentados como tal.
    { //=> Reaproveita requestDevice e os UUIDs do SDK, mas valida o protocolo do Briga.
        dispositivo = await navigator.bluetooth.requestDevice({filters: [{services: [servicoBriga]}]}); //=> O usuario escolhe o robo; nao conecta silenciosamente a qualquer dispositivo proximo.
        dispositivo.addEventListener('gattserverdisconnected', perdeuConexao); //=> Mantem a interface coerente quando a conexao e encerrada.
        const servidor = await dispositivo.gatt.connect(); //=> Estabelece a conexao BLE, nao Wi-Fi nem SerialBT.
        const servico = await servidor.getPrimaryService(servicoBriga); //=> Obtem o servico esperado antes de enviar comandos.
        caracteristica = await servico.getCharacteristic(caracteristicaBriga); //=> Mesmo ponto de pedido/resposta usado pelo SDK.
        geracaoConexao++; //=> Inicia uma nova geracao de transacoes.
        consultando = false; //=> Uma consulta de conexao encerrada nao prende o novo monitor.
        filaBluetooth = Promise.resolve(); //=> A nova conexao nao espera uma fila de conexao encerrada.
        aceitarResumo(await pedir(new Uint8Array([0x01]))); //=> Um firmware SDK original sera recusado antes de qualquer configuracao.
        elemento('estrategia').value = resumoAtual.config[0]; //=> Preenche os campos com valores confirmados, nao defaults da pagina.
        elemento('lado').value = resumoAtual.config[1]; //=> Usa o lado inicial salvo no firmware, nao a memoria de busca dinamica.
        elemento('bandeira').value = resumoAtual.config[2]; //=> Nao movimenta o servo ao atualizar o seletor.
        elemento('debug').checked = Boolean(resumoAtual.debug); //=> Mostra se a parada deste ensaio preservara RAM.
        elemento('conexao').textContent = `Conectado a ${dispositivo.name || 'Briga'}`; //=> Identifica o dispositivo efetivamente escolhido.
        mensagem('Conectado. Aplique a configuração e confira a confirmação antes da largada pelo IR.'); //=> Conectar nao inicia movimento.
        monitorando = true; //=> Comeca a consulta, sem forcar inicio ou retomada de captura no robo.
        consultar(); //=> Faz a primeira rodada; as seguintes se agendam no finally.
    } //=> Termina a conexao bem sucedida.
    catch (erro) //=> Nunca substitui falha por perfil ficticio de demonstracao.
    { //=> Fecha uma conexao parcial ou com protocolo incorreto.
        if (dispositivo?.gatt?.connected) dispositivo.gatt.disconnect(); //=> Nao deixa uma conexao errada ativa depois do handshake recusado.
        caracteristica = null; //=> Bloqueia comandos restantes da interface.
        mensagem(`Não conectou: ${erro.message}`, true); //=> Mantem a causa visivel para diagnostico.
    } //=> Termina o tratamento de falha.
    finally { atualizarQuadro(); } //=> Restaura os botoes conforme a conexao real.
} //=> Termina a acao de conectar.

async function salvarConfiguracao() //=> Substitui o envio das letras pelo Serial Bluetooth Terminal.
{ //=> Espera confirmacao de aplicacao, nao apenas o ACK de recebimento.
    if (salvando || !resumoAtual?.aberta || resumoAtual.parado) return; //=> O firmware tambem valida, mas a pagina evita pedidos ja sabidamente proibidos.
    const abertura = elemento('estrategia').value; //=> Mantem a letra original do switch de aberturas.
    const lado = elemento('lado').value; //=> Mantem <, > e = do menu anterior.
    if (lado === '=' && !'bfFz'.includes(abertura)) //=> As demais aberturas nao tratam frente corretamente no codigo recebido.
    { //=> Recusa entrada invalida sem reescrever as manobras antigas.
        mensagem('Esta abertura precisa de esquerda ou direita. Frente só é aceito em b, f, F ou z.', true); //=> Evita o travamento de A/frente sem alterar sua estrategia normal.
        return; //=> Nao envia uma configuracao que pode cair no laco antigo.
    } //=> Termina a validacao local dos seletores.
    salvando = true; //=> Mantem uma configuracao pendente por vez.
    atualizarQuadro(); //=> Desabilita o botao ate confirmar ou falhar.
    try //=> Trata recusa, desconexao e largada concorrente com o pedido.
    { //=> Envia todos os campos juntos, sem misturar duas selecoes diferentes.
        const pedido = new Uint8Array([0x03, abertura.charCodeAt(0), lado.charCodeAt(0), elemento('bandeira').value.charCodeAt(0), elemento('debug').checked ? 1 : 0]); //=> Cinco bytes: comando e quatro campos da preparacao.
        const resposta = await pedir(pedido); //=> Recebe o ticket, nao assume aplicacao imediata.
        if (!resposta.ok || !Number.isInteger(resposta.pedido)) throw new Error('Configuração não foi aceita.'); //=> Nunca anuncia sucesso para uma resposta incompleta.
        for (let i = 0; i < 30; i++) //=> Aguarda algumas consultas; nao trava a interface indefinidamente.
        { //=> O loop do firmware precisa aplicar antes da confirmacao final.
            aceitarResumo(await pedir(new Uint8Array([0x01]))); //=> Consulta a confirmacao feita por setupAuto.
            if (resumoAtual.recusado === resposta.pedido) throw new Error('A largada chegou antes de aplicar a configuração.'); //=> Nao esconde uma corrida com o comando IR.
            if (resumoAtual.aplicado === resposta.pedido) //=> Este e o ACK real da troca de variaveis no robo.
            { //=> Mostra sucesso somente depois da aplicacao.
                mensagem(`Configuração ${resposta.pedido} aplicada. A largada continua pelo controle IR.`); //=> Nao sugere que salvar iniciou o robo.
                return; //=> Encerra a espera bem sucedida.
            } //=> Termina a verificacao de confirmacao.
            await new Promise(resolve => setTimeout(resolve, 50)); //=> Da tempo ao loop sem ocupar o navegador com espera bloqueante.
        } //=> Termina as tentativas de confirmacao.
        throw new Error('Sem confirmação; consulte os valores confirmados antes de iniciar.'); //=> Timeout de interface nao prova se o pacote chegou ou nao.
    } //=> Termina o envio e espera.
    catch (erro) { mensagem(`Configuração: ${erro.message}`, true); } //=> Mantem erro visivel, sem alterar falsamente os dados confirmados.
    finally { salvando = false; atualizarQuadro(); } //=> Libera o botao de acordo com a fase real.
} //=> Termina a configuracao de preparacao.

async function controlarCaptura(acao) //=> 0 nova, 1 congela, 2 retoma; nao existe comando de movimento aqui.
{ //=> Apagar historico exige uma confirmacao do operador.
    if (acao === 0 && !window.confirm('Apagar o histórico do ESP32 e começar outra captura? Isso NÃO rearma nem para o robô.')) return; //=> Protege registros remotos ainda nao exportados.
    try //=> O servidor devolve o estado real da captura.
    { //=> Mantem a mesma fila de transacoes do monitor.
        aceitarResumo(await pedir(new Uint8Array([0x22, acao]))); //=> STOP pode impedir retomada; a tela respeita o resultado do firmware.
        mensagem(resumoAtual.parado ? 'Ensaio encerrado. Exporte os registros e use reset para um novo teste.' : 'Captura atualizada. Nenhum comando de motor foi enviado.'); //=> Distingue gravacao de controle fisico.
    } //=> Termina a alteracao apenas da captura.
    catch (erro) { mensagem(`Captura: ${erro.message}`, true); } //=> Recusa nao aparece como sucesso.
} //=> Termina o comando de captura.

function atualizarQuadro() //=> Mostra dados confirmados e desabilita acoes que nao fazem sentido na fase atual.
{ //=> Continua permitindo exportar dados locais sem conexao.
    const conectado = Boolean(caracteristica && dispositivo?.gatt?.connected); //=> Reflete a conexao real, nao um texto antigo.
    const podeConfigurar = conectado && Boolean(resumoAtual?.aberta) && !resumoAtual?.parado && !salvando; //=> Configuracao so antes da largada e do STOP.
    for (const id of ['estrategia', 'lado', 'bandeira', 'debug', 'salvar']) elemento(id).disabled = !podeConfigurar; //=> A placa tambem verifica essas permissoes.
    elemento('conectar').disabled = conectado; //=> Exige desconectar antes de escolher outro robo.
    elemento('desconectar').disabled = !conectado; //=> Nao oferece uma acao remota sem conexao.
    elemento('consultas').disabled = !conectado; //=> Pausa de polling nao desliga a captura.
    elemento('consultas').textContent = monitorando ? 'Pausar consultas' : 'Retomar consultas'; //=> Rotulo acompanha o estado real da consulta.
    const podeCapturar = conectado && Boolean(resumoAtual?.debug) && !resumoAtual?.parado; //=> Nenhum botao de captura desfaz o STOP.
    elemento('nova').disabled = !podeCapturar; //=> Protege o historico final depois da parada.
    elemento('congelar').disabled = !podeCapturar || !resumoAtual.gravando; //=> Congelar so tem efeito enquanto grava.
    elemento('retomar').disabled = !podeCapturar || Boolean(resumoAtual.gravando); //=> Retomar nao altera a opcao de debug escolhida antes da luta.
    if (!resumoAtual) return; //=> Antes do handshake nao inventa dados de sensores ou estado.
    const r = resumoAtual; //=> Nome curto apenas para o quadro recebido.
    elemento('permissao').textContent = r.parado ? 'Ensaio parado; reset para outro teste' : r.aberta ? 'Configuração aberta' : 'Configuração fechada após largada'; //=> Mostra a permissao do firmware.
    elemento('confirmado').textContent = `Confirmado na placa: abertura ${r.config[0]}, lado ${r.config[1]}, bandeira ${r.config[2]}, debug ${r.debug ? 'ligado' : 'desligado'}.`; //=> Nao sobrescreve seletores que o operador ainda esta editando.
    elemento('fase').textContent = r.fase; //=> Distingue fase geral de estado da busca.
    elemento('estado').textContent = nomeEstado(r.estado); //=> Traduz o mesmo enum presente no ZIP.
    elemento('duracaoEstado').textContent = `${r.parcial ? 'Desde primeira observação: ' : 'Tempo confirmado: '}${tempo(Math.max(0, (r.parado ? r.parada : r.us) - r.entrada))}${r.parado ? ' · lógica bloqueada' : ''}`; //=> Nao mede a duracao com o intervalo entre pacotes.
    elemento('motores').textContent = `${r.mE} / ${r.mD}`; //=> Exibe comandos reais da funcao, sem converter para velocidade medida.
    elemento('ciclos').textContent = `${r.ciclos} chamadas da busca`; //=> Conexao viva nao garante que este contador esteja aumentando.
    elemento('tempoCiclo').textContent = r.ultimoCiclo ? `Última: ${tempo(r.cicloUs)} · maior: ${tempo(r.maiorCiclo)} · concluída há ${tempo(Math.max(0, r.us - r.ultimoCiclo))}` : 'Busca ainda não concluiu um ciclo'; //=> Explicita uma abertura longa ou controle bloqueado.
    elemento('captura').textContent = `#${r.captura} · ${r.parado ? 'STOP / congelada' : r.gravando ? 'gravando' : 'sem gravar'}`; //=> Pausa de tela nao altera este estado remoto.
    elemento('perdas').textContent = `ESP32: ${r.total} eventos nesta captura, ${r.perdidos} sobrescritos na RAM. Página: ${registros.length} entradas, ${faltantes} eventos não recebidos, ${descartadosLocal} entradas locais descartadas.`; //=> Separa sobrescrita remota, lacuna real e descarte local.
    if (quadroSensores) //=> Mostra leituras apenas depois de receber uma resposta real.
    { //=> Mantem a idade da medicao distinta da idade da conexao.
        const s = quadroSensores; //=> Quadro completo preparado pela task de sensores.
        elemento('sensores').textContent = s.amostra ? `Linha E: ${s.linhaE}   Linha D: ${s.linhaD}   LDR: ${s.ldr}\nIR E: ${s.irE}   IR D: ${s.irD}   JSumo E: ${s.jsE}   JSumo D: ${s.jsD}\nIdade na resposta: ${tempo(Math.max(0, s.us - s.amostra))}` : 'A task ainda não publicou uma amostra.'; //=> Zero no valor de sensor nao e confundido com ausencia de leitura.
        if (s.aviso) elemento('sensores').textContent += `\nÚltima mensagem: ${s.aviso}`; //=> Mostra o ultimo aviso de preparacao como texto, sem executar HTML vindo da resposta.
    } //=> Termina a exibicao das leituras.
} //=> Termina o quadro atual sem acrescentar linhas ao historico.

function desenharHistorico() //=> Filtra apenas a visualizacao, preservando a captura e os registros exportaveis.
{ //=> Exibe no maximo cinquenta entradas por pagina.
    const filtro = elemento('filtro').value; //=> O operador pode focar estados, linha ou motores.
    const visiveis = registros.filter(r => r.nota || filtro === 'todos' || (filtro === 'estados' && [0, 5].includes(r.tipo)) || (filtro === 'linha' && (r.rec > 0 || [2, 3, 4].includes(r.tipo))) || (filtro === 'motores' && r.tipo === 1) || (filtro === 'marcas' && r.tipo === 6)); //=> Eventos de motor dentro da fuga tambem aparecem no filtro linha.
    afastamentoPagina = Math.min(afastamentoPagina, Math.max(0, Math.floor((visiveis.length - 1) / 50))); //=> Mantem a pagina valida depois de trocar filtro ou descartar entradas antigas.
    const fim = Math.max(0, visiveis.length - afastamentoPagina * 50); //=> Zero de afastamento aponta para os eventos mais recentes.
    const inicio = Math.max(0, fim - 50); //=> Limita o tamanho do DOM sem apagar dados da exportacao.
    const corpo = elemento('registros'); //=> Destino apenas da tabela de acontecimentos.
    corpo.replaceChildren(); //=> Substitui as linhas visiveis, nao o historico armazenado.
    for (const r of visiveis.slice(inicio, fim)) //=> Monta apenas a pagina selecionada.
    { //=> Usa elementos e textContent, nunca HTML vindo do dispositivo.
        const linha = document.createElement('tr'); //=> Cria uma linha visual para este evento ou marca.
        if (r.nota) //=> Lacunas e separacoes de sessao sao linhas explicitas.
        { //=> Uma nota ocupa toda a largura da tabela.
            linha.className = 'lacuna'; //=> Destaca que nao se trata de uma transicao normal.
            const celula = document.createElement('td'); //=> Texto puro evita executar conteudo recebido.
            celula.colSpan = 6; //=> Usa as seis colunas da tabela.
            celula.textContent = r.nota; //=> Preserva a explicacao do trecho ausente.
            linha.appendChild(celula); //=> Insere a nota na linha.
        } //=> Termina a nota de sessao ou perda.
        else //=> Registro normal de estado, motor, fase ou recuperacao.
        { //=> Converte somente para apresentacao humana.
            const evento = r.tipo === 0 ? `${nomeEstado(r.de)} → ${nomeEstado(r.para)}` : nomesTipos[r.tipo] || `TIPO_${r.tipo}`; //=> Mostra transicao por nomes sem ocultar tipos desconhecidos.
            const idade = r.amostra ? tempo(Math.max(0, r.us - r.amostra)) : 'sem amostra'; //=> A leitura anexada pode ser anterior a condicao exata do if.
            const campos = [`#${r.n}\n${tempo(r.us)}\ncaptura ${r.captura}`, evento, r.dur < 0 ? 'Parcial / não se aplica' : tempo(r.dur), `${r.ciclo} / ${r.rec || '—'}`, `${r.mE} / ${r.mD}`, `${r.motivo}\nLinha ${r.linhaE} / ${r.linhaD} · LDR ${r.ldr}\nIR ${r.irE}/${r.irD} · JSumo ${r.jsE}/${r.jsD}\nAmostra: ${idade}`]; //=> Preserva motivo e numero da fuga, nao apenas o enum do estado.
            for (const campo of campos) //=> Preenche as colunas com texto escapado pelo DOM.
            { //=> Cada valor vai para uma celula independente.
                const celula = document.createElement('td'); //=> Nao utiliza innerHTML para dados do BLE.
                celula.textContent = campo; //=> Trata todo o conteudo como texto literal.
                linha.appendChild(celula); //=> Acrescenta a coluna na ordem do cabecalho.
            } //=> Termina as colunas deste evento.
        } //=> Termina o registro normal.
        corpo.appendChild(linha); //=> Exibe a linha sem mudar o cursor remoto.
    } //=> Termina a pagina de eventos.
    elemento('pagina').textContent = visiveis.length ? `${inicio + 1}–${fim} de ${visiveis.length} entradas do filtro` : 'Sem eventos neste filtro'; //=> Evita confundir pagina vazia com falta de funcionamento da captura.
    elemento('anteriores').disabled = inicio === 0; //=> Nao permite navegar para antes do primeiro registro retido.
    elemento('recentes').disabled = afastamentoPagina === 0; //=> Indica quando ja esta na pagina mais recente.
    renderPendente = false; //=> A pagina foi atualizada; novas chegadas marcarao outra renderizacao.
} //=> Termina a visualizacao paginada.

function exportarCSV() //=> Salva os eventos ainda disponiveis no navegador, independentemente do filtro.
{ //=> CSV nao recupera o que nunca chegou nem persiste automaticamente depois de fechar a pagina.
    const colunas = ['sessao', 'captura', 'n', 'us', 'dur', 'tipo', 'de', 'para', 'ciclo', 'rec', 'mE', 'mD', 'linhaE', 'linhaD', 'ldr', 'irE', 'irD', 'jsE', 'jsD', 'amostra', 'motivo', 'nota']; //=> Preserva dados brutos para analisar depois, alem da apresentacao da tela.
    const escapar = valor => //=> Protege delimitadores, aspas e texto que uma planilha poderia interpretar como formula.
    { //=> Converte apenas uma celula de cada vez.
        let texto = String(valor ?? ''); //=> Valores ausentes ficam vazios, nao como undefined.
        if (typeof valor === 'string' && /^[=+\-@]/.test(texto)) texto = "'" + texto; //=> Comandos numericos negativos continuam numeros; textos potencialmente executaveis sao neutralizados.
        return '"' + texto.replaceAll('"', '""') + '"'; //=> Escapa aspas de acordo com CSV.
    }; //=> Termina o escape de celula.
    const dados = [{nota: `Exportação local: ${faltantes} eventos não recebidos; ${descartadosLocal} entradas locais descartadas.`}, ...registros]; //=> O arquivo tambem informa limitacoes e trechos ausentes.
    const linhas = [colunas.join(';'), ...dados.map(r => colunas.map(c => escapar(r[c])).join(';'))]; //=> Usa ponto e virgula para facilitar abertura em planilhas configuradas em portugues.
    const arquivo = new Blob(['\uFEFF' + linhas.join('\r\n')], {type: 'text/csv;charset=utf-8'}); //=> UTF-8 com marcador preserva acentos em leitores de CSV comuns.
    const endereco = URL.createObjectURL(arquivo); //=> Cria um endereco local para salvar, sem enviar dados a um servidor.
    const link = document.createElement('a'); //=> Aciona o salvamento pelo navegador.
    link.href = endereco; //=> Aponta para o arquivo gerado na propria pagina.
    link.download = `briga_debug_${new Date().toISOString().replaceAll(':', '-')}.csv`; //=> Inclui data sem caracteres invalidos em nomes no Windows.
    link.click(); //=> O navegador oferece o arquivo ao operador.
    setTimeout(() => URL.revokeObjectURL(endereco), 1000); //=> Libera o objeto local depois de iniciar o salvamento.
} //=> Termina a exportacao sem alterar a memoria do robo.

function alternarConsultas() //=> Pausa de rede e independente da pausa visual e do gravador remoto.
{ //=> Muda apenas o monitor desta pagina.
    monitorando = !monitorando; //=> O ESP32 continua registrando conforme sua propria configuracao.
    clearTimeout(temporizador); //=> Nao deixa uma rodada antiga agendada ao pausar.
    if (monitorando) consultar(); //=> Retoma do mesmo cursor, reconhecendo lacunas se houve sobrescrita.
    atualizarQuadro(); //=> Atualiza o rotulo do botao sem mover motores.
} //=> Termina o controle de polling.

elemento('conectar').onclick = conectar; //=> A solicitacao de dispositivo so nasce deste clique.
elemento('desconectar').onclick = () => dispositivo?.gatt?.disconnect(); //=> Desconexao deixa historico local disponivel e nao e STOP.
elemento('salvar').onclick = salvarConfiguracao; //=> Substitui os caracteres de configuracao enviados pelo terminal antigo.
elemento('nova').onclick = () => controlarCaptura(0); //=> Reinicia apenas o historico apos confirmacao.
elemento('congelar').onclick = () => controlarCaptura(1); //=> Pausa gravacao sem confundir com parada do robo.
elemento('retomar').onclick = () => controlarCaptura(2); //=> Retoma apenas se o firmware permitir e nao estiver parado por STOP.
elemento('consultas').onclick = alternarConsultas; //=> Permite ler com menos atividade Bluetooth sem mudar a captura remota.
elemento('exportar').onclick = exportarCSV; //=> Exporta mesmo depois de desconectar o dispositivo.
elemento('filtro').onchange = () => { afastamentoPagina = 0; desenharHistorico(); }; //=> Trocar filtro volta aos eventos mais recentes, sem excluir os outros.
elemento('pausarTela').onchange = () => { if (!elemento('pausarTela').checked) desenharHistorico(); }; //=> Retomar a tela exibe o que foi recebido enquanto ela estava congelada.
elemento('anteriores').onclick = () => { afastamentoPagina++; desenharHistorico(); }; //=> Consulta uma pagina anterior do historico local.
elemento('recentes').onclick = () => { afastamentoPagina = 0; desenharHistorico(); }; //=> Volta a acompanhar a pagina mais recente.
setInterval(() => //=> Atualiza somente a indicacao da idade, sem criar pedidos Bluetooth adicionais.
{ //=> A idade local distingue dados recebidos de uma conexao que deixou de responder.
    elemento('atualizacao').textContent = recebidoEm ? `Última resposta há ${((performance.now() - recebidoEm) / 1000).toFixed(1)} s${monitorando ? '' : ' · consultas pausadas'}` : 'Sem dados'; //=> Nao faz a duracao dos estados crescer usando o relogio do celular.
}, 500); //=> Meio segundo basta para indicar dados antigos sem inundar logs.
desenharHistorico(); //=> Inicia a tabela vazia de forma explicita.
atualizarQuadro(); //=> Comeca com botoes remotos desabilitados ate o handshake.
