import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
loadEnv(join(root, ".env"));

const publicDir = join(root, "public");
const port = Number(process.env.PORT || 3000);
const host = cleanHost(process.env.IXC_HOST || "jmstelecomsp.com.br");
const token = process.env.IXC_TOKEN || "";
const ponCache = {
  expiresAt: 0,
  rows: []
};

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    if (url.pathname === "/api/clientes") {
      await handleClientes(url, res);
      return;
    }

    if (url.pathname === "/api/pons") {
      await handlePons(res);
      return;
    }

    if (url.pathname === "/api/debug") {
      await handleDebug(res);
      return;
    }

    await serveStatic(url.pathname, res);
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Erro interno" });
  }
});

server.listen(port, () => {
  console.log(`Interface IXC disponível em http://localhost:${port}`);
});

async function handleClientes(url, res) {
  if (!token) {
    sendJson(res, 500, {
      error: "IXC_TOKEN não configurado. Defina a variável de ambiente antes de iniciar o servidor."
    });
    return;
  }

  const page = positiveInt(url.searchParams.get("page"), 1);
  const pageSize = clamp(positiveInt(url.searchParams.get("pageSize"), 25), 10, 200);
  const search = String(url.searchParams.get("search") || "").trim();
  const pon = String(url.searchParams.get("pon") || "").trim();

  if (pon || looksLikePon(search)) {
    await handleClientesByPon(res, {
      page,
      pageSize,
      pon: pon || search,
      exact: Boolean(pon)
    });
    return;
  }

  const clientesData = await fetchPage("cliente", {
    page,
    pageSize,
    qtype: search ? "cliente.razao" : "cliente.id",
    query: search || "0",
    oper: search ? "L" : ">",
    sortname: "cliente.razao"
  });

  const clientes = clientesData.rows;
  const details = await Promise.all(clientes.map((cliente) => loadClientDetails(cliente)));
  const warnings = details.flatMap((detail) => detail.warnings);

  const rows = clientes.map((cliente, index) => {
    const { login, fibra, contrato } = details[index];
    const idCliente = first(cliente, ["id", "id_cliente"]);
    const idLogin = first(login, ["id", "id_radusuario", "id_login"]);

    return {
      id: idCliente,
      nome: first(cliente, ["razao", "nome", "fantasia", "cliente"]) || "",
      login: first(login, ["login", "usuario", "user", "username"]) || "",
      bairro:
        first(cliente, ["bairro", "bairro_entrega", "endereco_bairro"]) ||
        first(login, ["bairro"]) ||
        "",
      pon:
        first(fibra, ["pon", "ponid", "id_pon", "porta_pon", "olt_pon", "interface_pon"]) ||
        first(login, ["pon", "id_pon", "porta_pon"]) ||
        "",
      clienteAtivo: labelYesNo(first(cliente, ["ativo"])),
      online: labelYesNo(first(login, ["online"])),
      statusContrato: labelContractStatus(first(contrato, ["status", "status_contrato"])),
      statusAcesso: labelAccessStatus(
        first(contrato, ["status_internet", "status_acesso"]) ||
          first(login, ["ativo", "status", "status_acesso"])
      ),
      raw: {
        clienteAtivo: first(cliente, ["ativo"]),
        online: first(login, ["online"]),
        statusContrato: first(contrato, ["status", "status_contrato"]),
        statusAcesso:
          first(contrato, ["status_internet", "status_acesso"]) ||
          first(login, ["ativo", "status", "status_acesso"]),
        idLogin
      }
    };
  });

  sendJson(res, 200, {
    page,
    pageSize,
    total: clientesData.total,
    totalPages: Math.max(1, Math.ceil(clientesData.total / pageSize)),
    warnings: [...new Set(warnings)],
    rows
  });
}

async function handleClientesByPon(res, { page, pageSize, pon, exact }) {
  const fibrasData = await fetchPage("radpop_radio_cliente_fibra", {
    page,
    pageSize,
    qtype: "radpop_radio_cliente_fibra.ponid",
    query: pon,
    oper: exact ? "=" : "L",
    sortname: "radpop_radio_cliente_fibra.ponid"
  });

  const details = await Promise.all(fibrasData.rows.map((fibra) => loadClientDetailsFromFibra(fibra)));
  const rows = details.map((detail) => buildRow(detail.cliente, detail.login, detail.fibra, detail.contrato));
  const warnings = details.flatMap((detail) => detail.warnings);

  sendJson(res, 200, {
    page,
    pageSize,
    total: fibrasData.total,
    totalPages: Math.max(1, Math.ceil(fibrasData.total / pageSize)),
    warnings: [...new Set(warnings)],
    rows
  });
}

async function loadClientDetails(cliente) {
  const idCliente = first(cliente, ["id", "id_cliente"]);
  const warnings = [];
  let login = {};
  let fibra = {};
  let contrato = {};

  const [loginResult, contratoResult] = await Promise.allSettled([
    fetchFirst("radusuarios", "radusuarios.id_cliente", idCliente),
    fetchFirst("cliente_contrato", "cliente_contrato.id_cliente", idCliente)
  ]);

  if (loginResult.status === "fulfilled") {
    login = loginResult.value || {};
  } else {
    warnings.push(`radusuarios: ${loginResult.reason.message}`);
  }

  if (contratoResult.status === "fulfilled") {
    contrato = contratoResult.value || {};
  } else {
    warnings.push(`cliente_contrato: ${contratoResult.reason.message}`);
  }

  const idLogin = first(login, ["id", "id_radusuario", "id_login"]);
  if (idLogin) {
    const fibraResult = await Promise.allSettled([
      fetchFirst("radpop_radio_cliente_fibra", "radpop_radio_cliente_fibra.id_login", idLogin)
    ]);

    if (fibraResult[0].status === "fulfilled") {
      fibra = fibraResult[0].value || {};
    } else {
      warnings.push(`radpop_radio_cliente_fibra: ${fibraResult[0].reason.message}`);
    }
  }

  return { login, fibra, contrato, warnings };
}

async function loadClientDetailsFromFibra(fibra) {
  const idLogin = first(fibra, ["id_login", "id_radusuario", "id_radusuarios", "radusuario_id"]);
  const warnings = [];
  let login = {};
  let cliente = {};
  let contrato = {};

  const loginResult = await Promise.allSettled([fetchFirst("radusuarios", "radusuarios.id", idLogin)]);
  if (loginResult[0].status === "fulfilled") {
    login = loginResult[0].value || {};
  } else {
    warnings.push(`radusuarios: ${loginResult[0].reason.message}`);
  }

  const idCliente = first(login, ["id_cliente", "cliente_id", "idcliente"]);
  const [clienteResult, contratoResult] = await Promise.allSettled([
    fetchFirst("cliente", "cliente.id", idCliente),
    fetchFirst("cliente_contrato", "cliente_contrato.id_cliente", idCliente)
  ]);

  if (clienteResult.status === "fulfilled") {
    cliente = clienteResult.value || {};
  } else {
    warnings.push(`cliente: ${clienteResult.reason.message}`);
  }

  if (contratoResult.status === "fulfilled") {
    contrato = contratoResult.value || {};
  } else {
    warnings.push(`cliente_contrato: ${contratoResult.reason.message}`);
  }

  return { cliente, login, fibra, contrato, warnings };
}

async function handlePons(res) {
  if (!token) {
    sendJson(res, 500, {
      error: "IXC_TOKEN não configurado no arquivo .env."
    });
    return;
  }

  const now = Date.now();
  if (ponCache.expiresAt > now) {
    sendJson(res, 200, { rows: ponCache.rows });
    return;
  }

  const fibras = await fetchAllPages("radpop_radio_cliente_fibra", {
    qtype: "radpop_radio_cliente_fibra.id",
    query: "0",
    oper: ">",
    sortname: "radpop_radio_cliente_fibra.ponid"
  });

  const rows = [...new Set(fibras.map((fibra) => first(fibra, ["ponid", "pon"])).filter(Boolean))]
    .sort(comparePon)
    .map((pon) => ({ pon }));

  ponCache.rows = rows;
  ponCache.expiresAt = now + 10 * 60 * 1000;
  sendJson(res, 200, { rows });
}

async function handleDebug(res) {
  const checks = {
    host,
    tokenConfigurado: Boolean(token),
    endpoints: {}
  };

  if (!token) {
    sendJson(res, 500, {
      ...checks,
      error: "IXC_TOKEN não configurado no arquivo .env."
    });
    return;
  }

  for (const resource of ["cliente", "radusuarios", "cliente_contrato", "radpop_radio_cliente_fibra"]) {
    try {
      const data = await ixcPost(resource, {
        qtype: `${resource}.id`,
        query: "0",
        oper: ">",
        page: "1",
        rp: "1",
        sortname: `${resource}.id`,
        sortorder: "asc"
      });

      const rows = normalizeRows(data);
      checks.endpoints[resource] = {
        ok: true,
        registros: rows.length,
        campos: rows[0] ? Object.keys(rows[0]).slice(0, 120) : [],
        exemplo: rows[0] ? redactRecord(rows[0]) : {},
        bruto: summarizeResponse(data)
      };
    } catch (error) {
      checks.endpoints[resource] = {
        ok: false,
        erro: error.message
      };
    }
  }

  const failed = Object.values(checks.endpoints).some((endpoint) => !endpoint.ok);
  sendJson(res, failed ? 500 : 200, checks);
}

async function fetchPage(resource, options = {}) {
  const page = options.page || 1;
  const pageSize = options.pageSize || 50;
  const data = await ixcPost(resource, {
    qtype: options.qtype || `${resource}.id`,
    query: options.query || "0",
    oper: options.oper || ">",
    page: String(page),
    rp: String(pageSize),
    sortname: options.sortname || `${resource}.id`,
    sortorder: options.sortorder || "asc"
  });

  return {
    total: Number(data?.total || normalizeRows(data).length || 0),
    rows: normalizeRows(data)
  };
}

async function fetchAllPages(resource, options = {}) {
  const pageSize = options.pageSize || 1000;
  const all = [];

  for (let page = 1; page <= 100; page += 1) {
    const data = await fetchPage(resource, {
      ...options,
      page,
      pageSize
    });

    all.push(...data.rows);

    if (all.length >= data.total || data.rows.length < pageSize) {
      break;
    }
  }

  return all;
}

async function fetchFirst(resource, qtype, query) {
  if (!query) return {};

  const page = await fetchPage(resource, {
    page: 1,
    pageSize: 1,
    qtype,
    query,
    oper: "=",
    sortname: `${resource}.id`
  });

  return page.rows[0] || {};
}

function buildRow(cliente, login, fibra, contrato) {
  const idCliente = first(cliente, ["id", "id_cliente"]);
  const idLogin = first(login, ["id", "id_radusuario", "id_login"]);

  return {
    id: idCliente,
    nome: first(cliente, ["razao", "nome", "fantasia", "cliente"]) || "",
    login: first(login, ["login", "usuario", "user", "username"]) || "",
    bairro:
      first(cliente, ["bairro", "bairro_entrega", "endereco_bairro"]) ||
      first(login, ["bairro"]) ||
      first(fibra, ["bairro"]) ||
      "",
    pon:
      first(fibra, ["pon", "ponid", "id_pon", "porta_pon", "olt_pon", "interface_pon"]) ||
      first(login, ["pon", "id_pon", "porta_pon"]) ||
      "",
    clienteAtivo: labelYesNo(first(cliente, ["ativo"])),
    online: labelYesNo(first(login, ["online"])),
    statusContrato: labelContractStatus(first(contrato, ["status", "status_contrato"])),
    statusAcesso: labelAccessStatus(
      first(contrato, ["status_internet", "status_acesso"]) ||
        first(login, ["ativo", "status", "status_acesso"])
    ),
    raw: {
      clienteAtivo: first(cliente, ["ativo"]),
      online: first(login, ["online"]),
      statusContrato: first(contrato, ["status", "status_contrato"]),
      statusAcesso:
        first(contrato, ["status_internet", "status_acesso"]) ||
        first(login, ["ativo", "status", "status_acesso"]),
      idLogin
    }
  };
}

async function ixcPost(resource, body) {
  const auth = Buffer.from(token).toString("base64");
  const response = await fetch(`https://${host}/webservice/v1/${resource}`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
      ixcsoft: "listar"
    },
    body: JSON.stringify(body)
  });

  const text = await response.text();
  let data;

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`IXC retornou uma resposta inválida em ${resource}: ${text.slice(0, 160)}`);
  }

  if (!response.ok) {
    throw new Error(
      data?.message ||
        data?.error ||
        data?.type ||
        `Erro ${response.status} ao consultar ${resource}: ${text.slice(0, 180)}`
    );
  }

  return data;
}

function summarizeResponse(data) {
  if (!data || typeof data !== "object") return data;
  return {
    type: Array.isArray(data) ? "array" : "object",
    keys: Object.keys(data).slice(0, 20),
    total: data.total,
    page: data.page,
    registros: Array.isArray(data.registros) ? data.registros.length : undefined,
    rows: Array.isArray(data.rows) ? data.rows.length : undefined,
    data: Array.isArray(data.data) ? data.data.length : undefined
  };
}

function redactRecord(record) {
  const redacted = {};
  const sensitive = /(senha|password|token|chave|secret|cpf|cnpj|rg|identidade|fone|telefone|email|mac)/i;

  for (const [key, value] of Object.entries(record).slice(0, 120)) {
    redacted[key] = sensitive.test(key) ? "***" : value;
  }

  return redacted;
}

function normalizeRows(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.registros)) return data.registros;
  if (Array.isArray(data?.rows)) return data.rows;
  if (Array.isArray(data?.data)) return data.data;
  return [];
}

function first(record, keys) {
  for (const key of keys) {
    const value = record?.[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return String(value).trim();
    }
  }
  return "";
}

function labelYesNo(value) {
  const normalized = String(value || "").toUpperCase();
  if (normalized === "S" || normalized === "SS") return "Sim";
  if (normalized === "N" || normalized === "NN") return "Não";
  return value || "";
}

function labelContractStatus(value) {
  const labels = {
    A: "Ativo",
    I: "Inativo",
    P: "Pré-contrato",
    N: "Negativado",
    D: "Desistiu"
  };
  return labels[String(value || "").toUpperCase()] || value || "";
}

function labelAccessStatus(value) {
  const labels = {
    A: "Ativo",
    S: "Ativo",
    D: "Desativado",
    N: "Desativado",
    CM: "Corte manual",
    CA: "Corte automático",
    FA: "Financeiro em atraso",
    AA: "Aguardando assinatura"
  };
  return labels[String(value || "").toUpperCase()] || value || "";
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function looksLikePon(value) {
  return /\d+\s*\/\s*\d+\s*\/\s*\d+/.test(String(value || ""));
}

function comparePon(a, b) {
  const left = splitPon(a);
  const right = splitPon(b);

  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    if (leftValue !== rightValue) return leftValue - rightValue;
  }

  return String(a).localeCompare(String(b), "pt-BR");
}

function splitPon(value) {
  return String(value)
    .split("/")
    .map((part) => Number.parseInt(part, 10))
    .filter((part) => Number.isFinite(part));
}

async function serveStatic(pathname, res) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const requested = normalize(join(publicDir, safePath));

  if (!requested.startsWith(publicDir)) {
    sendText(res, 403, "Acesso negado");
    return;
  }

  try {
    const file = await readFile(requested);
    res.writeHead(200, {
      "Content-Type": contentTypes[extname(requested)] || "application/octet-stream"
    });
    res.end(file);
  } catch {
    sendText(res, 404, "Arquivo não encontrado");
  }
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function sendText(res, status, text) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

function cleanHost(value) {
  return String(value)
    .replace(/^https?:\/\//, "")
    .replace(/\/adm\.php.*$/, "")
    .replace(/\/.*$/, "")
    .trim();
}

function loadEnv(path) {
  if (!existsSync(path)) return;

  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) continue;

    const index = trimmed.indexOf("=");
    if (index === -1) continue;

    const key = trimmed.slice(0, index).trim();
    const value = trimmed
      .slice(index + 1)
      .trim()
      .replace(/^['"]|['"]$/g, "");

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
