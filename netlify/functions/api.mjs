// API da Macarronada do Catão. Guarda tudo no Netlify Blobs.
// Variáveis de ambiente (Netlify > Project configuration > Environment variables):
//   SENHA_EQUIPE      senha de quem usa o sistema completo
//   SENHA_ENTREGADOR  senha do entregador (vê só a aba Entrega)
//   TOKEN_SECRET      texto longo e aleatório, usado para assinar o login
import { getStore } from "@netlify/blobs";
import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";

export const config = { path: "/api/*" };

const MENU_PADRAO = [
  { id: "trad-ind", nome: "Tradicional - Individual", desc: "Ideal para até 2 pessoas", preco: 50, cat: "macarronada", ativo: true },
  { id: "trad-fam", nome: "Tradicional - Família", desc: "Ideal para até 4 pessoas", preco: 75, cat: "macarronada", ativo: true },
  { id: "pimenta-ind", nome: "Com Pimenta - Individual", desc: "Ideal para até 2 pessoas", preco: 50, cat: "macarronada", ativo: true },
  { id: "pimenta-fam", nome: "Com Pimenta - Família", desc: "Ideal para até 4 pessoas", preco: 75, cat: "macarronada", ativo: true },
  { id: "eita-300", nome: "Suco EITA-EITA 300 ml", desc: "", preco: 15, cat: "suco", ativo: true },
  { id: "eita-500", nome: "Suco EITA-EITA 500 ml", desc: "", preco: 25, cat: "suco", ativo: true },
  { id: "creme-cupuacu", nome: "Creme de cupuaçu", desc: "", preco: 15, cat: "sobremesa", ativo: true },
  { id: "creme-maracuja", nome: "Creme de maracujá", desc: "", preco: 15, cat: "sobremesa", ativo: true },
];
const PIX_PADRAO = {
  chave: "macarronadadocatao@gmail.com",
  copia: "00020101021126500014br.gov.bcb.pix0128macarronadadocatao@gmail.com5204000053039865802BR5918LEONARDO C PEREIRA6009BOA VISTA62070503***63041602",
};
const CONFIGS = ["cardapio", "entregador", "pix", "retirada"];
const SESSAO_MS = 1000 * 60 * 60 * 24 * 30; // 30 dias
const ID_OK = /^[A-Za-z0-9_-]{1,64}$/;

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const store = () => getStore({ name: "catao", consistency: "strong" });

// ---------- login ----------
function segredo() {
  return process.env.TOKEN_SECRET || "";
}
function assinar(papel, exp) {
  const corpo = `${papel}.${exp}`;
  const sig = createHmac("sha256", segredo()).update(corpo).digest("base64url");
  return `${corpo}.${sig}`;
}
function lerToken(req) {
  const h = req.headers.get("authorization") || "";
  const t = h.startsWith("Bearer ") ? h.slice(7) : "";
  const p = t.split(".");
  if (p.length !== 3 || !segredo()) return null;
  const [papel, exp, sig] = p;
  const esperado = createHmac("sha256", segredo()).update(`${papel}.${exp}`).digest("base64url");
  const a = Buffer.from(sig), b = Buffer.from(esperado);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (!(Number(exp) > Date.now())) return null;
  return papel === "equipe" || papel === "entregador" ? papel : null;
}
function igual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

// ---------- utilidades de dados ----------
async function lerDoc(s, chave, padrao = null) {
  const v = await s.get(chave, { type: "json" });
  return v == null ? padrao : v;
}
async function marcarVersao(s, qual) {
  await s.set(qual, randomBytes(6).toString("hex") + Date.now().toString(36));
}
async function versao(s, qual) {
  return (await s.get(qual)) || "0";
}
async function listarPedidos(s) {
  const { blobs } = await s.list({ prefix: "pedidos/" });
  const docs = await Promise.all(blobs.map((b) => lerDoc(s, b.key)));
  return docs.filter(Boolean);
}
const txt = (v, max) => String(v == null ? "" : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim().slice(0, max);

async function limitarIp(s, req) {
  const ip = (req.headers.get("x-nf-client-connection-ip") || req.headers.get("x-forwarded-for") || "desconhecido").split(",")[0].trim();
  const janela = Math.floor(Date.now() / 60000);
  const chave = `limite/${ip.replace(/[^0-9a-fA-F:.]/g, "_")}`;
  const atual = (await lerDoc(s, chave, { j: 0, n: 0 })) || { j: 0, n: 0 };
  const n = atual.j === janela ? atual.n + 1 : 1;
  await s.setJSON(chave, { j: janela, n });
  return n <= 6; // no máximo 6 pedidos por minuto por endereço
}

// ---------- rotas ----------
export default async (req) => {
  const url = new URL(req.url);
  const rota = url.pathname.replace(/^\/api\/?/, "").replace(/\/$/, "");
  const s = store();

  try {
    // pública: cardápio, Pix e retirada para a página do cliente
    if (req.method === "GET" && rota === "publico") {
      const [cardapio, pix, retirada] = await Promise.all([
        lerDoc(s, "config/cardapio"),
        lerDoc(s, "config/pix"),
        lerDoc(s, "config/retirada"),
      ]);
      const itens = cardapio && Array.isArray(cardapio.itens) && cardapio.itens.length ? cardapio.itens : MENU_PADRAO;
      return json({
        itens: itens.map((i) => ({ id: i.id, nome: i.nome, desc: i.desc || "", preco: i.preco, cat: i.cat, ativo: i.ativo !== false })),
        pix: pix || PIX_PADRAO,
        retirada: (retirada && retirada.texto) || "",
      });
    }

    // pública: o cliente envia o pedido
    if (req.method === "POST" && rota === "pedido") {
      const bruto = await req.text();
      if (bruto.length > 12000) return json({ erro: "Pedido grande demais." }, 413);
      let b;
      try { b = JSON.parse(bruto); } catch { return json({ erro: "Pedido inválido." }, 400); }
      if (b.site) return json({ ok: true, numero: 0 }); // campo-isca: robôs preenchem, pessoas não
      if (!(await limitarIp(s, req))) return json({ erro: "Muitas tentativas. Espere um minuto." }, 429);

      const cliente = txt(b.cliente, 80);
      const telefone = txt(b.telefone, 30);
      const tipo = b.tipo === "retirada" ? "retirada" : "entrega";
      if (!cliente || telefone.replace(/\D/g, "").length < 10) return json({ erro: "Informe nome e WhatsApp." }, 400);
      const endereco = tipo === "entrega" ? txt(b.endereco, 240) : "";
      const mapa = tipo === "entrega" ? txt(b.mapa, 200) : "";
      if (tipo === "entrega" && !endereco && !mapa) return json({ erro: "Informe o endereço ou a localização." }, 400);

      const cardapio = await lerDoc(s, "config/cardapio");
      const menu = cardapio && Array.isArray(cardapio.itens) && cardapio.itens.length ? cardapio.itens : MENU_PADRAO;
      const porNome = new Map(menu.map((m) => [String(m.nome).trim().toLowerCase(), m]));
      const brutoItens = Array.isArray(b.itens) ? b.itens.slice(0, 30) : [];
      const itens = [];
      for (const i of brutoItens) {
        const m = porNome.get(String(i && i.nome).trim().toLowerCase());
        const qtd = Math.floor(Number(i && i.qtd));
        if (!m || m.ativo === false || !(qtd >= 1) || qtd > 50) return json({ erro: "Há um item indisponível no pedido. Recarregue a página." }, 400);
        itens.push({ nome: m.nome, preco: Number(m.preco), qtd, cat: m.cat || "macarronada" });
      }
      if (!itens.length) return json({ erro: "Escolha pelo menos um item." }, 400);
      const total = Math.round(itens.reduce((t, i) => t + i.preco * i.qtd, 0) * 100) / 100;
      const agora = Date.now();
      const id = agora.toString(36) + randomBytes(3).toString("hex");
      const pedido = {
        id, cliente, telefone, tipo, endereco, mapa, taxa: 0,
        pagamento: "Pix", troco: "", obs: txt(b.obs, 300),
        itens, total, pago: false, status: "aguarda",
        criadoEm: agora, atualizadoEm: agora, origem: "site",
      };
      await s.setJSON(`pedidos/${id}`, pedido);
      await marcarVersao(s, "meta/versao");
      return json({ ok: true, id, total });
    }

    // login
    if (req.method === "POST" && rota === "login") {
      if (!segredo() || !process.env.SENHA_EQUIPE) return json({ erro: "Senhas ainda não configuradas no Netlify." }, 503);
      let b = {};
      try { b = await req.json(); } catch {}
      const senha = String(b.senha || "");
      let papel = null;
      if (igual(senha, process.env.SENHA_EQUIPE)) papel = "equipe";
      else if (process.env.SENHA_ENTREGADOR && igual(senha, process.env.SENHA_ENTREGADOR)) papel = "entregador";
      if (!papel) {
        await new Promise((r) => setTimeout(r, 800));
        return json({ erro: "Senha incorreta." }, 401);
      }
      const exp = Date.now() + SESSAO_MS;
      return json({ token: assinar(papel, exp), papel, exp });
    }

    // daqui em diante: só logado
    const papel = lerToken(req);
    if (!papel) return json({ erro: "Entre com a senha." }, 401);

    if (req.method === "GET" && rota === "estado") {
      const v = await versao(s, "meta/versao");
      const fv = await versao(s, "meta/fotos");
      if (url.searchParams.get("v") === v + "|" + fv) return json({ igual: true });
      const [pedidos, cardapio, entregador, pix, retirada] = await Promise.all([
        listarPedidos(s),
        lerDoc(s, "config/cardapio"),
        lerDoc(s, "config/entregador"),
        lerDoc(s, "config/pix"),
        lerDoc(s, "config/retirada"),
      ]);
      let lista = pedidos;
      if (papel === "entregador") {
        lista = pedidos.filter((o) => o.tipo === "entrega" && ["embalar", "pronto", "saiu", "entregue"].includes(o.status));
      }
      return json({
        v: v + "|" + fv,
        papel,
        pedidos: lista,
        config: papel === "equipe" ? { cardapio, entregador, pix, retirada } : { entregador },
      });
    }

    if (req.method === "GET" && rota === "fotos") {
      const { blobs } = await s.list({ prefix: "fotos/" });
      const docs = await Promise.all(blobs.map(async (b) => [b.key.slice(6), await lerDoc(s, b.key)]));
      const fotos = {};
      docs.forEach(([id, d]) => { if (d && d.img) fotos[id] = d.img; });
      return json({ fotos });
    }

    // escrita: {colecao, id, op, data}
    if (req.method === "POST" && rota === "doc") {
      const b = await req.json();
      const colecao = String(b.colecao || ""), id = String(b.id || ""), op = String(b.op || "");
      if (!ID_OK.test(id)) return json({ erro: "Id inválido." }, 400);

      if (papel === "entregador") {
        // entregador só avança o pedido para "saiu" ou "entregue"
        if (colecao !== "pedidos" || op !== "update") return json({ erro: "Sem permissão." }, 403);
        const st = b.data && b.data.status;
        if (st !== "saiu" && st !== "entregue") return json({ erro: "Sem permissão." }, 403);
        const atual = await lerDoc(s, `pedidos/${id}`);
        if (!atual || atual.tipo !== "entrega") return json({ erro: "Pedido não encontrado." }, 404);
        await s.setJSON(`pedidos/${id}`, { ...atual, status: st, atualizadoEm: Date.now() });
        await marcarVersao(s, "meta/versao");
        return json({ ok: true });
      }

      let chave, meta = "meta/versao";
      if (colecao === "pedidos") chave = `pedidos/${id}`;
      else if (colecao === "config" && CONFIGS.includes(id)) chave = `config/${id}`;
      else if (colecao === "fotos") { chave = `fotos/${id}`; meta = "meta/fotos"; }
      else return json({ erro: "Coleção inválida." }, 400);

      const dados = b.data && typeof b.data === "object" ? b.data : {};
      const tam = JSON.stringify(dados).length;
      if (tam > (colecao === "fotos" ? 400000 : 200000)) return json({ erro: "Dados grandes demais." }, 413);

      if (op === "set") await s.setJSON(chave, dados);
      else if (op === "update") {
        const atual = (await lerDoc(s, chave)) || {};
        await s.setJSON(chave, { ...atual, ...dados });
      } else if (op === "delete") await s.delete(chave);
      else return json({ erro: "Operação inválida." }, 400);

      await marcarVersao(s, meta);
      return json({ ok: true });
    }

    return json({ erro: "Não encontrado." }, 404);
  } catch (e) {
    console.error(e);
    return json({ erro: "Erro no servidor." }, 500);
  }
};
