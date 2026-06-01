const tableBody = document.querySelector("#tableBody");
const statusText = document.querySelector("#status");
const refreshButton = document.querySelector("#refreshButton");
const exportButton = document.querySelector("#exportButton");
const searchInput = document.querySelector("#searchInput");
const ponInput = document.querySelector("#ponInput");
const pageSizeInput = document.querySelector("#pageSizeInput");
const previousButton = document.querySelector("#previousButton");
const nextButton = document.querySelector("#nextButton");
const pageInfo = document.querySelector("#pageInfo");

let rows = [];
let lastError = "";
let page = 1;
let totalPages = 1;
let totalRows = 0;
let searchTimer;

refreshButton.addEventListener("click", () => loadClientes());
exportButton.addEventListener("click", exportExcel);
searchInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    page = 1;
    loadClientes();
  }, 350);
});
pageSizeInput.addEventListener("change", () => {
  page = 1;
  loadClientes();
});
ponInput.addEventListener("change", () => {
  page = 1;
  loadClientes();
});
previousButton.addEventListener("click", () => {
  if (page > 1) {
    page -= 1;
    loadClientes();
  }
});
nextButton.addEventListener("click", () => {
  if (page < totalPages) {
    page += 1;
    loadClientes();
  }
});

loadPons();
loadClientes();

async function loadClientes() {
  setLoading(true);
  statusText.textContent = "Consultando clientes no IXC...";
  tableBody.innerHTML = `<tr><td colspan="8" class="empty">Carregando...</td></tr>`;

  try {
    const params = new URLSearchParams({
      page: String(page),
      pageSize: pageSizeInput.value,
      search: searchInput.value.trim(),
      pon: ponInput.value
    });
    const response = await fetch(`/api/clientes?${params}`);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Falha ao buscar dados.");
    }

    rows = data.rows || [];
    page = data.page || page;
    totalPages = data.totalPages || 1;
    totalRows = data.total || rows.length;
    lastError = "";
    renderTable();
    updatePagination();
    statusText.textContent = data.warnings?.length
      ? `${totalRows.toLocaleString("pt-BR")} clientes encontrados. Página com aviso: ${data.warnings.join(" | ")}`
      : `${totalRows.toLocaleString("pt-BR")} clientes encontrados.`;
  } catch (error) {
    rows = [];
    lastError = error.message;
    renderTable();
    updatePagination();
    statusText.textContent = "Não foi possível carregar os dados.";
  } finally {
    setLoading(false);
  }
}

async function loadPons() {
  try {
    ponInput.disabled = true;
    const response = await fetch("/api/pons");
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Falha ao carregar PONs.");
    }

    ponInput.innerHTML = [
      `<option value="">Todas</option>`,
      ...(data.rows || []).map((row) => `<option value="${escapeHtml(row.pon)}">${escapeHtml(row.pon)}</option>`)
    ].join("");
  } catch {
    ponInput.innerHTML = `<option value="">Todas</option>`;
  } finally {
    ponInput.disabled = false;
  }
}

function renderTable() {
  if (rows.length === 0) {
    const message = lastError
      ? `${lastError} Abra /api/debug para ver o diagnóstico.`
      : "Nenhum cliente encontrado.";
    tableBody.innerHTML = `<tr><td colspan="8" class="empty">${escapeHtml(message)}</td></tr>`;
    return;
  }

  tableBody.innerHTML = rows
    .map(
      (row) => `
        <tr>
          <td>${escapeHtml(row.nome)}</td>
          <td>${escapeHtml(row.login)}</td>
          <td>${escapeHtml(row.bairro)}</td>
          <td>${escapeHtml(row.pon)}</td>
          <td>${statusBadge(row.clienteAtivo)}</td>
          <td>${statusBadge(row.online)}</td>
          <td>${statusBadge(row.statusContrato)}</td>
          <td>${statusBadge(row.statusAcesso)}</td>
        </tr>
      `
    )
    .join("");
}

function exportExcel() {
  const header = [
    "Nome do cliente",
    "Login",
    "Bairro",
    "PON",
    "Cliente ativo",
    "Online",
    "Status contrato",
    "Status acesso"
  ];
  const body = rows.map((row) => [
    row.nome,
    row.login,
    row.bairro,
    row.pon,
    row.clienteAtivo,
    row.online,
    row.statusContrato,
    row.statusAcesso
  ]);
  const csv = [header, ...body].map((line) => line.map(csvCell).join(";")).join("\r\n");
  const blob = new Blob([`\ufeff${csv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = `clientes-ixc-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function csvCell(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function setLoading(isLoading) {
  refreshButton.disabled = isLoading;
  exportButton.disabled = isLoading || rows.length === 0;
  previousButton.disabled = isLoading || page <= 1;
  nextButton.disabled = isLoading || page >= totalPages;
}

function updatePagination() {
  pageInfo.textContent = `Página ${page.toLocaleString("pt-BR")} de ${totalPages.toLocaleString(
    "pt-BR"
  )}`;
  previousButton.disabled = page <= 1;
  nextButton.disabled = page >= totalPages;
}

function statusBadge(value) {
  const text = escapeHtml(value || "");
  if (!text) return "";

  const className = statusClass(text);
  return `<span class="status ${className}">${text}</span>`;
}

function statusClass(value) {
  const normalized = String(value).toLowerCase();
  if (["sim", "ativo", "online"].some((word) => normalized.includes(word))) return "good";
  if (["não", "nao", "inativo", "desativado", "desistiu", "negativado"].some((word) => normalized.includes(word))) {
    return "bad";
  }
  if (["corte", "atraso", "aguardando", "pré", "pre"].some((word) => normalized.includes(word))) return "warn";
  return "";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
