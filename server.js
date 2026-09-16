const express = require('express');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());

// Configurações da API do Asaas e Porta
const ASAAS_API_URL = process.env.ASAAS_ENV === 'producao' 
    ? 'https://api.asaas.com/v3' 
    : 'https://sandbox.asaas.com/v3';

const asaasHeaders = {
    'access_token': process.env.ASAAS_API_KEY,
    'Content-Type': 'application/json'
};

const PORT = process.env.PORT || 3000;

// Banco de dados simulado em memória (ou substitua pelas tabelas do PostgreSQL)
let clientes = [];
let lojistas = [];
let transacoes = [];

// 1. ROTA DE ATIVAÇÃO DE CONTA (O Cliente paga o Pix inicial para ter o Nível 1)
app.post('/api/ativar-conta', async (req, res) => {
    const { nome, cpf, email, telefone } = req.body;

    try {
        // Passo A: Cria o cliente na base do Asaas
        const clienteAsaas = await axios.post(`${ASAAS_API_URL}/customers`, {
            name: nome,
            cpfCnpj: cpf,
            email: email,
            phone: telefone
        }, { headers: asaasHeaders });

        const customerId = clienteAsaas.data.id;

        // Passo B: Gera a cobrança Pix de ativação do Nível 1 (R$ 2,00 para liberar R$ 20,00 de limite)
        const valorAtivacao = 2.00;
        const cobrancaPix = await axios.post(`${ASAAS_API_URL}/payments`, {
            customer: customerId,
            billingType: 'PIX',
            value: valorAtivacao,
            dueDate: new Date(Date.now() + 86400000).toISOString().split('T')[0], // Vencimento para amanhã
            description: 'Taxa de Ativação CrediFlex - Nível 1 (Limite de R$ 20,00)'
        }, { headers: asaasHeaders });

        // Salva o cliente na nossa base com Nível 1 bloqueado até o pagamento
        const novoCliente = {
            id: customerId,
            nome,
            cpf,
            nivel: 1,
            limiteAtual: 20.00,
            pontos: 0,
            statusAtivacao: 'AGUARDANDO_PIX',
            faturaAberta: 0,
            cobrancaAtivacaoId: cobrancaPix.data.id
        };
        clientes.push(novoCliente);

        return res.json({
            sucesso: true,
            mensagem: 'Conta criada com sucesso! Pague o Pix de ativação para liberar seu limite.',
            pixQrCodeUrl: cobrancaPix.data.invoiceUrl,
            qrCodePayload: cobrancaPix.data.pixQrCodeUrl // Payload copia e cola
        });

    } catch (error) {
        console.error(error.response?.data || error.message);
        return res.status(500).json({ sucesso: false, erro: 'Erro ao processar ativação no Asaas.' });
    }
});

// 2. ROTA DE COMPRA NO LOJISTA (Buy Now, Pay Later)
app.post('/api/comprar', (req, res) => {
    const { clienteId, lojistaId, valorCompra } = req.body;

    const cliente = clientes.find(c => c.id === clienteId);
    if (!cliente) return res.status(404).json({ sucesso: false, erro: 'Cliente não encontrado.' });

    if (cliente.statusAtivacao !== 'ATIVO') {
        return res.status(400).json({ sucesso: false, erro: 'Sua conta precisa estar ativa com o Pix inicial.' });
    }

    // Verifica se o cliente tem limite disponível
    const limiteDisponivel = cliente.limiteAtual - cliente.faturaAberta;
    if (valorCompra > limiteDisponivel) {
        return res.status(400).json({ sucesso: false, erro: `Limite insuficiente. Seu saldo disponível é R$ ${limiteDisponivel.toFixed(2)}` });
    }

    // Registra a compra e atualiza a fatura aberta
    cliente.faturaAberta += valorCompra;

    // Calcula a retenção do lucro da plataforma (ex: Taxa MDR de 4% para a lojista)
    const taxaPlataforma = valorCompra * 0.04;
    const repasseLojista = valorCompra - taxaPlataforma;

    transacoes.push({
        id: Date.now(),
        clienteId,
        lojistaId,
        valorBruto: valorCompra,
        lucroPlataforma: taxaPlataforma,
        repasseLiquido: repasseLojista,
        data: new Date(),
        status: 'PENDENTE_PAGAMENTO'
    });

    return res.json({
        sucesso: true,
        mensagem: 'Compra aprovada com sucesso!',
        novoLimiteDisponivel: cliente.limiteAtual - cliente.faturaAberta
    });
});

// 3. WEBHOOK DO ASAAS (Recebe avisos quando o cliente paga faturas ou ativações)
app.post('/api/webhook/asaas', (req, res) => {
    const evento = req.body;

    if (evento.event === 'PAYMENT_RECEIVED') {
        const paymentId = evento.payment.id;
        const customerId = evento.payment.customer;

        const cliente = clientes.find(c => c.id === customerId);
        if (cliente) {
            // Se for o pagamento da ativação inicial
            if (cliente.cobrancaAtivacaoId === paymentId && cliente.statusAtivacao === 'AGUARDANDO_PIX') {
                cliente.statusAtivacao = 'ATIVO';
                console.log(`Cliente ${cliente.nome} ativou o Nível 1 com sucesso!`);
            } 
            // Se for o pagamento da fatura de compras com evolução de nível
            else {
                cliente.faturaAberta = 0; // Zera a fatura
                cliente.pontos += 50;     // Ganha pontos de fidelidade

                // Regra de Progressão de Nível (Sem novos depósitos!)
                if (cliente.pontos >= 150 && cliente.nivel === 1) {
                    cliente.nivel = 2;
                    cliente.limiteAtual = 50.00;
                } else if (cliente.pontos >= 300 && cliente.nivel === 2) {
                    cliente.nivel = 3;
                    cliente.limiteAtual = 100.00;
                }
                console.log(`Fatura paga por ${cliente.nome}. Nível atualizado para: ${cliente.nivel}`);
            }
        }
    }

    return res.status(200).json({ recebido: true });
});

// Inicializa o Servidor
app.listen(PORT, () => {
    console.log(`Servidor CrediFlex rodando profissionalmente na porta ${PORT}`);
});