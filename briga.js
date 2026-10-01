'use strict';
// Conexao BLE do Briga. UUIDs e protocolo precisam corresponder ao firmware.
const servicoBriga = '0000ff10-0000-1000-8000-00805f9b34fb';
const caracteristicaBriga = '0000ff11-0000-1000-8000-00805f9b34fb';
// A ordem acompanha EstadoRobo e TipoDebug nos headers do firmware.
const nomesEstados = ['BUSCAR', 'ALINHAR_FRENTE', 'ESPERAR_ALVO', 'AVANCAR_LENTO', 'VIRAR_LATERAL_E', 'VIRAR_LATERAL_D', 'ATAQUE_RAPIDO'];
const nomesTipos = ['ESTADO', 'MOTOR', 'INÍCIO LINHA', 'ETAPA LINHA', 'FIM LINHA', 'FASE', 'MARCA'];
let dispositivo = null;
let caracteristica = null;
let filaBluetooth = Promise.resolve();
let geracaoConexao = 0; // Descarta respostas de uma conexao que ja terminou.
let monitorando = false;
let consultando = false;
let temporizador = null;
let resumoAtual = null;
let quadroSensores = null;
let recebidoEm = 0;
let sessao = null;
let captura = null;
let cursor = 0; // Ultimo evento recebido nesta sessao/captura.
let registros = [];
let descartadosLocal = 0;
let faltantes = 0;
let afastamentoPagina = 0;
let salvando = false;
let renderPendente = false;

function elemento(id) { return document.getElementById(id); }
function mensagem(texto, erro = false)
{
    elemento('mensagem').textContent = texto;
    elemento('mensagem').className = erro ? 'erro' : '';
}
function nomeEstado(numero) { return nomesEstados[numero] || `ESTADO_${numero}`; }
function tempo(us) { return (us / 1000).toLocaleString('pt-BR', {maximumFractionDigits: 3}) + ' ms'; }

// Serializa cada WRITE/READ para nao misturar respostas de pedidos diferentes.
function pedir(bytes)
{
    const geracao = geracaoConexao;
    const executar = async () =>
    {
        const canal = caracteristica;
        if (!canal || !dispositivo?.gatt?.connected || geracao !== geracaoConexao) throw new Error('Robô desconectado; clique em Conectar.');
        await canal.writeValueWithResponse(bytes);
        const dados = await canal.readValue();
        if (geracao !== geracaoConexao) throw new Error('Resposta de uma conexão encerrada.');
        const resposta = JSON.parse(new TextDecoder().decode(dados));
        if (!resposta || typeof resposta !== 'object' || resposta.erro) throw new Error(resposta?.erro || 'Resposta inválida.');
        return resposta;
    };
    const resultado = filaBluetooth.then(executar, executar);
    filaBluetooth = resultado.catch(() => {});
    return resultado;
}

// Historico local limitado. Os descartes sao contados e incluidos no CSV.
function guardar(registro)
{
    registros.push(registro);
    if (registros.length > 10000)
    {
        const excesso = registros.length - 10000;
        registros.splice(0, excesso);
        descartadosLocal += excesso;
    }
    renderPendente = true;
}

// Troca de boot ou captura reinicia o cursor, mas conserva os eventos locais anteriores.
function aceitarResumo(resumo)
{
    if (resumo.protocolo !== 'BRIGA_BLE_1' || !Number.isInteger(resumo.sessao) || !Number.isInteger(resumo.captura) || !Number.isSafeInteger(resumo.us)) throw new Error('Este dispositivo não usa o protocolo desta página do Briga.');
    if (sessao !== resumo.sessao || captura !== resumo.captura)
    {
        quadroSensores = null;
        elemento('sensores').textContent = 'Aguardando uma amostra desta sessão.';
        sessao = resumo.sessao;
        captura = resumo.captura;
        cursor = 0;
        guardar({sessao, captura, nota: `Sessão ${sessao}, captura ${captura}`});
    }
    resumoAtual = resumo;
    recebidoEm = performance.now();
    atualizarQuadro();
}

// Repeticoes nao entram duas vezes; saltos na numeracao aparecem como lacunas.
function aceitarEvento(resposta)
{
    if (resposta.sessao !== sessao || resposta.captura !== captura) throw new Error('A sessão mudou; atualize a consulta.');
    const evento = resposta.evento;
    if (evento === null) return false;
    if (!evento || !Number.isInteger(evento.n) || evento.n < 1 || !Number.isSafeInteger(evento.us) || !Number.isSafeInteger(evento.dur) || !Number.isInteger(evento.tipo) || typeof evento.motivo !== 'string') throw new Error('Registro incompleto ou inválido.');
    if (evento.n <= cursor) return true;
    if (evento.n > cursor + 1)
    {
        const quantidade = evento.n - cursor - 1;
        faltantes += quantidade;
        guardar({sessao, captura, nota: `LACUNA: ${quantidade} eventos não recebidos (${cursor + 1} a ${evento.n - 1})`});
    }
    guardar({sessao, captura, ...evento});
    cursor = evento.n;
    return true;
}

// Pedido: comando 0x21 + sessao, captura e cursor em quatro bytes little-endian cada.
async function buscarEvento()
{
    const pedido = new Uint8Array(13);
    pedido[0] = 0x21;
    const numeros = new DataView(pedido.buffer);
    numeros.setUint32(1, sessao, true);
    numeros.setUint32(5, captura, true);
    numeros.setUint32(9, cursor, true);
    return aceitarEvento(await pedir(pedido));
}

// Consulta resumo, sensores e ate oito eventos. So agenda a proxima rodada ao terminar.
async function consultar()
{
    if (!monitorando || consultando || !caracteristica) return;
    consultando = true;
    const geracao = geracaoConexao;
    try
    {
        aceitarResumo(await pedir(new Uint8Array([0x01])));
        quadroSensores = await pedir(new Uint8Array([0x02]));
        for (let i = 0; i < 8 && monitorando && cursor < resumoAtual.total; i++)
        {
            if (!await buscarEvento()) break;
        }
        atualizarQuadro();
        if (renderPendente && !elemento('pausarTela').checked && afastamentoPagina === 0) desenharHistorico();
    }
    catch (erro) { if (geracao === geracaoConexao) mensagem(`Consulta interrompida: ${erro.message}. Os valores exibidos podem estar antigos.`, true); }
    finally
    {
        if (geracao === geracaoConexao)
        {
            consultando = false;
            if (monitorando) temporizador = setTimeout(consultar, 200);
        }
    }
}

// A perda de conexao nao e STOP. Mantem o historico recebido e sinaliza dados antigos.
function perdeuConexao()
{
    geracaoConexao++;
    caracteristica = null;
    monitorando = false;
    clearTimeout(temporizador);
    elemento('conexao').textContent = 'Desconectado — histórico local preservado';
    mensagem('Bluetooth desconectado. Isso não para o robô; use o controle IR.', true);
    atualizarQuadro();
}

// A selecao do dispositivo depende do clique do operador e de um contexto seguro.
async function conectar()
{
    if (!window.isSecureContext || !navigator.bluetooth)
    {
        mensagem('Use Chrome com Web Bluetooth em HTTPS ou http://localhost. No celular, publique a pasta site em HTTPS.', true);
        return;
    }
    elemento('conectar').disabled = true;
    try
    {
        dispositivo = await navigator.bluetooth.requestDevice({filters: [{services: [servicoBriga]}]});
        dispositivo.addEventListener('gattserverdisconnected', perdeuConexao);
        const servidor = await dispositivo.gatt.connect();
        const servico = await servidor.getPrimaryService(servicoBriga);
        caracteristica = await servico.getCharacteristic(caracteristicaBriga);
        geracaoConexao++;
        consultando = false;
        filaBluetooth = Promise.resolve();
        aceitarResumo(await pedir(new Uint8Array([0x01])));
        elemento('estrategia').value = resumoAtual.config[0];
        elemento('lado').value = resumoAtual.config[1];
        elemento('bandeira').value = resumoAtual.config[2];
        elemento('debug').checked = Boolean(resumoAtual.debug);
        elemento('conexao').textContent = `Conectado a ${dispositivo.name || 'Briga'}`;
        mensagem('Conectado. Aplique a configuração e confira a confirmação antes da largada pelo IR.');
        monitorando = true;
        consultar();
    }
    catch (erro)
    {
        if (dispositivo?.gatt?.connected) dispositivo.gatt.disconnect();
        caracteristica = null;
        mensagem(`Não conectou: ${erro.message}`, true);
    }
    finally { atualizarQuadro(); }
}

// Aguarda o numero aplicado pelo loop; receber o pedido no BLE nao basta para confirmar.
async function salvarConfiguracao()
{
    if (salvando || !resumoAtual?.aberta || resumoAtual.parado) return;
    const abertura = elemento('estrategia').value;
    const lado = elemento('lado').value;
    if (lado === '=' && !'bfFz'.includes(abertura))
    {
        mensagem('Esta abertura precisa de esquerda ou direita. Frente só é aceito em b, f, F ou z.', true);
        return;
    }
    salvando = true;
    atualizarQuadro();
    try
    {
        const pedido = new Uint8Array([0x03, abertura.charCodeAt(0), lado.charCodeAt(0), elemento('bandeira').value.charCodeAt(0), elemento('debug').checked ? 1 : 0]);
        const resposta = await pedir(pedido);
        if (!resposta.ok || !Number.isInteger(resposta.pedido)) throw new Error('Configuração não foi aceita.');
        for (let i = 0; i < 30; i++)
        {
            aceitarResumo(await pedir(new Uint8Array([0x01])));
            if (resumoAtual.recusado === resposta.pedido) throw new Error('A largada chegou antes de aplicar a configuração.');
            if (resumoAtual.aplicado === resposta.pedido)
            {
                mensagem(`Configuração ${resposta.pedido} aplicada. A largada continua pelo controle IR.`);
                return;
            }
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw new Error('Sem confirmação; consulte os valores confirmados antes de iniciar.');
    }
    catch (erro) { mensagem(`Configuração: ${erro.message}`, true); }
    finally { salvando = false; atualizarQuadro(); }
}

// 0: nova captura; 1: congelar; 2: retomar. Nenhum desses comandos rearma o robo.
async function controlarCaptura(acao)
{
    if (acao === 0 && !window.confirm('Apagar o histórico do ESP32 e começar outra captura? Isso NÃO rearma nem para o robô.')) return;
    try
    {
        aceitarResumo(await pedir(new Uint8Array([0x22, acao])));
        mensagem(resumoAtual.parado ? 'Ensaio encerrado. Exporte os registros e use reset para um novo teste.' : 'Captura atualizada. Nenhum comando de motor foi enviado.');
    }
    catch (erro) { mensagem(`Captura: ${erro.message}`, true); }
}

// Atualiza o quadro atual sem acrescentar linhas ao historico.
function atualizarQuadro()
{
    const conectado = Boolean(caracteristica && dispositivo?.gatt?.connected);
    const podeConfigurar = conectado && Boolean(resumoAtual?.aberta) && !resumoAtual?.parado && !salvando;
    for (const id of ['estrategia', 'lado', 'bandeira', 'debug', 'salvar']) elemento(id).disabled = !podeConfigurar;
    elemento('conectar').disabled = conectado;
    elemento('desconectar').disabled = !conectado;
    elemento('consultas').disabled = !conectado;
    elemento('consultas').textContent = monitorando ? 'Pausar consultas' : 'Retomar consultas';
    const podeCapturar = conectado && Boolean(resumoAtual?.debug) && !resumoAtual?.parado;
    elemento('nova').disabled = !podeCapturar;
    elemento('congelar').disabled = !podeCapturar || !resumoAtual.gravando;
    elemento('retomar').disabled = !podeCapturar || Boolean(resumoAtual.gravando);
    if (!resumoAtual) return;
    const r = resumoAtual;
    elemento('permissao').textContent = r.parado ? 'Ensaio parado; reset para outro teste' : r.aberta ? 'Configuração aberta' : 'Configuração fechada após largada';
    elemento('confirmado').textContent = `Confirmado na placa: abertura ${r.config[0]}, lado ${r.config[1]}, bandeira ${r.config[2]}, debug ${r.debug ? 'ligado' : 'desligado'}.`;
    elemento('fase').textContent = r.fase;
    elemento('estado').textContent = nomeEstado(r.estado);
    elemento('duracaoEstado').textContent = `${r.parcial ? 'Desde primeira observação: ' : 'Tempo confirmado: '}${tempo(Math.max(0, (r.parado ? r.parada : r.us) - r.entrada))}${r.parado ? ' · lógica bloqueada' : ''}`;
    elemento('motores').textContent = `${r.mE} / ${r.mD}`;
    elemento('ciclos').textContent = `${r.ciclos} chamadas da busca`;
    elemento('tempoCiclo').textContent = r.ultimoCiclo ? `Última: ${tempo(r.cicloUs)} · maior: ${tempo(r.maiorCiclo)} · concluída há ${tempo(Math.max(0, r.us - r.ultimoCiclo))}` : 'Busca ainda não concluiu um ciclo';
    elemento('captura').textContent = `#${r.captura} · ${r.parado ? 'STOP / congelada' : r.gravando ? 'gravando' : 'sem gravar'}`;
    elemento('perdas').textContent = `ESP32: ${r.total} eventos nesta captura, ${r.perdidos} sobrescritos na RAM. Página: ${registros.length} entradas, ${faltantes} eventos não recebidos, ${descartadosLocal} entradas locais descartadas.`;
    if (quadroSensores)
    {
        const s = quadroSensores;
        elemento('sensores').textContent = s.amostra ? `Linha E: ${s.linhaE}   Linha D: ${s.linhaD}   LDR: ${s.ldr}\nIR E: ${s.irE}   IR D: ${s.irD}   JSumo E: ${s.jsE}   JSumo D: ${s.jsD}\nIdade na resposta: ${tempo(Math.max(0, s.us - s.amostra))}` : 'A task ainda não publicou uma amostra.';
        if (s.aviso) elemento('sensores').textContent += `\nÚltima mensagem: ${s.aviso}`;
    }
}

// Filtra somente a exibicao e mostra 50 entradas por pagina.
function desenharHistorico()
{
    const filtro = elemento('filtro').value;
    const visiveis = registros.filter(r => r.nota || filtro === 'todos' || (filtro === 'estados' && [0, 5].includes(r.tipo)) || (filtro === 'linha' && (r.rec > 0 || [2, 3, 4].includes(r.tipo))) || (filtro === 'motores' && r.tipo === 1) || (filtro === 'marcas' && r.tipo === 6));
    afastamentoPagina = Math.min(afastamentoPagina, Math.max(0, Math.floor((visiveis.length - 1) / 50)));
    const fim = Math.max(0, visiveis.length - afastamentoPagina * 50);
    const inicio = Math.max(0, fim - 50);
    const corpo = elemento('registros');
    corpo.replaceChildren();
    for (const r of visiveis.slice(inicio, fim))
    {
        const linha = document.createElement('tr');
        if (r.nota)
        {
            linha.className = 'lacuna';
            const celula = document.createElement('td');
            celula.colSpan = 6;
            celula.textContent = r.nota;
            linha.appendChild(celula);
        }
        else
        {
            const evento = r.tipo === 0 ? `${nomeEstado(r.de)} → ${nomeEstado(r.para)}` : nomesTipos[r.tipo] || `TIPO_${r.tipo}`;
            const idade = r.amostra ? tempo(Math.max(0, r.us - r.amostra)) : 'sem amostra';
            const campos = [`#${r.n}\n${tempo(r.us)}\ncaptura ${r.captura}`, evento, r.dur < 0 ? 'Parcial / não se aplica' : tempo(r.dur), `${r.ciclo} / ${r.rec || '—'}`, `${r.mE} / ${r.mD}`, `${r.motivo}\nLinha ${r.linhaE} / ${r.linhaD} · LDR ${r.ldr}\nIR ${r.irE}/${r.irD} · JSumo ${r.jsE}/${r.jsD}\nAmostra: ${idade}`];
            for (const campo of campos)
            {
                const celula = document.createElement('td');
                celula.textContent = campo;
                linha.appendChild(celula);
            }
        }
        corpo.appendChild(linha);
    }
    elemento('pagina').textContent = visiveis.length ? `${inicio + 1}–${fim} de ${visiveis.length} entradas do filtro` : 'Sem eventos neste filtro';
    elemento('anteriores').disabled = inicio === 0;
    elemento('recentes').disabled = afastamentoPagina === 0;
    renderPendente = false;
}

// Exporta todos os registros ainda guardados no navegador, independente do filtro.
function exportarCSV()
{
    const colunas = ['sessao', 'captura', 'n', 'us', 'dur', 'tipo', 'de', 'para', 'ciclo', 'rec', 'mE', 'mD', 'linhaE', 'linhaD', 'ldr', 'irE', 'irD', 'jsE', 'jsD', 'amostra', 'motivo', 'nota'];
    const escapar = valor =>
    {
        let texto = String(valor ?? '');
        if (typeof valor === 'string' && /^[=+\-@]/.test(texto)) texto = "'" + texto; // Evita interpretar texto como formula ao abrir em uma planilha.
        return '"' + texto.replaceAll('"', '""') + '"';
    };
    const dados = [{nota: `Exportação local: ${faltantes} eventos não recebidos; ${descartadosLocal} entradas locais descartadas.`}, ...registros];
    const linhas = [colunas.join(';'), ...dados.map(r => colunas.map(c => escapar(r[c])).join(';'))];
    const arquivo = new Blob(['\uFEFF' + linhas.join('\r\n')], {type: 'text/csv;charset=utf-8'});
    const endereco = URL.createObjectURL(arquivo);
    const link = document.createElement('a');
    link.href = endereco;
    link.download = `briga_debug_${new Date().toISOString().replaceAll(':', '-')}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(endereco), 1000);
}

// Pausar consultas nao pausa a captura na placa.
function alternarConsultas()
{
    monitorando = !monitorando;
    clearTimeout(temporizador);
    if (monitorando) consultar();
    atualizarQuadro();
}

// Botoes do painel: exibicao, consultas e captura sao controles separados.
elemento('conectar').onclick = conectar;
elemento('desconectar').onclick = () => dispositivo?.gatt?.disconnect();
elemento('salvar').onclick = salvarConfiguracao;
elemento('nova').onclick = () => controlarCaptura(0);
elemento('congelar').onclick = () => controlarCaptura(1);
elemento('retomar').onclick = () => controlarCaptura(2);
elemento('consultas').onclick = alternarConsultas;
elemento('exportar').onclick = exportarCSV;
elemento('filtro').onchange = () => { afastamentoPagina = 0; desenharHistorico(); };
elemento('pausarTela').onchange = () => { if (!elemento('pausarTela').checked) desenharHistorico(); };
elemento('anteriores').onclick = () => { afastamentoPagina++; desenharHistorico(); };
elemento('recentes').onclick = () => { afastamentoPagina = 0; desenharHistorico(); };
// A idade da resposta continua visivel mesmo com as consultas pausadas.
setInterval(() =>
{
    elemento('atualizacao').textContent = recebidoEm ? `Última resposta há ${((performance.now() - recebidoEm) / 1000).toFixed(1)} s${monitorando ? '' : ' · consultas pausadas'}` : 'Sem dados';
}, 500);
desenharHistorico();
atualizarQuadro();
