/* Tỷ giá USD — bản web của công cụ HTA.
   Để trống nếu chưa có Apps Script trung gian cho MB và VietinBank. */
var bankTables = {};

var results = [];
var running = false;
var cancelled = false;
var activeBank = "acb";
var activeBankName = "ACB";
var activeBuyLabel = "Mua chuyển khoản";
var activeSellLabel = "Bán chuyển khoản";

var vtbActions = {
    times: "e4d951bbcfdef7e590919ae33e39d2a200f3d9e7",
    rates: "1e43a43a5124d6cc3cb463bc54021b34f39a4065"
};

function parseDates(text) {
    var lines = String(text).split(/\r?\n/);
    var dates = [];
    var re = /(^|[^\d])(\d{1,2}\/\d{1,2}\/\d{4})(?!\d)/;

    for (var i = 0; i < lines.length; i++) {
        var line = lines[i].replace(/\|/g, " ");
        var match;

        while ((match = line.match(re)) !== null) {
            dates.push(match[2]);
            line = line.substring(match.index + match[0].length);
        }
    }

    return dates;
}

function toApiDate(dateStr) {
    var parts = dateStr.split("/");

    if (parts.length !== 3) {
        throw new Error("Ngày không đúng định dạng DD/MM/YYYY: " + dateStr);
    }

    var day = parts[0];
    var month = parts[1];
    var year = parts[2];

    if (day.length === 1) {
        day = "0" + day;
    }

    if (month.length === 1) {
        month = "0" + month;
    }

    if (!/^\d{4}$/.test(year)) {
        throw new Error("Ngày không đúng định dạng DD/MM/YYYY: " + dateStr);
    }

    return {
        day: day,
        month: month,
        year: year,
        isoDate: year + "-" + month + "-" + day
    };
}

function bankMeta(bank) {
    if (bank === "vcb") {
        return {
            name: "Vietcombank",
            buy: "Mua chuyển khoản",
            sell: "Bán",
            hint: "Vietcombank: Mua = USD chuyển khoản (transfer), Bán = USD sell"
        };
    }

    if (bank === "mb") {
        return {
            name: "MB",
            buy: "Mua chuyển khoản",
            sell: "Bán chuyển khoản",
            hint: "MB: Mua = USD chuyển khoản, Bán = USD chuyển khoản"
        };
    }

    if (bank === "bidv") {
        return {
            name: "BIDV",
            buy: "Mua chuyển khoản",
            sell: "Bán chuyển khoản",
            hint: "BIDV: Mua = USD chuyển khoản, Bán = USD bán. Lấy lần công bố mới nhất trong ngày."
        };
    }

    if (bank === "stb") {
        return {
            name: "Sacombank",
            buy: "Mua chuyển khoản",
            sell: "Bán chuyển khoản",
            hint: "Sacombank: Mua = USD chuyển khoản, Bán = USD chuyển khoản. Lấy khung giờ mới nhất trong ngày."
        };
    }

    if (bank === "vtb") {
        return {
            name: "VietinBank",
            buy: "Mua chuyển khoản",
            sell: "Bán chuyển khoản",
            hint: "VietinBank: Mua = USD chuyển khoản, Bán = USD bán. Lấy khung giờ mới nhất trong ngày."
        };
    }

    return {
        name: "ACB",
        buy: "Mua chuyển khoản",
        sell: "Bán chuyển khoản",
        hint: "ACB: Mua = USD BID TRANSFER, Bán = USD ASK TRANSFER"
    };
}

function applyBankLabels(bank) {
    var meta = bankMeta(bank);

    activeBank = bank;
    activeBankName = meta.name;
    activeBuyLabel = meta.buy;
    activeSellLabel = meta.sell;

    document.getElementById("buyHeaderText").textContent = meta.buy;
    document.getElementById("sellHeaderText").textContent = meta.sell;
    document.getElementById("bankHint").textContent = meta.hint;
}

function onBankChanged() {
    if (running) {
        return;
    }

    var bank = document.getElementById("bankSelect").value;

    if (results.length) {
        document.getElementById("bankHint").textContent =
            bankMeta(bank).hint + " — bấm Lấy tỷ giá để tải dữ liệu mới.";
        return;
    }

    applyBankLabels(bank);
}

function setBankLocked(locked) {
    document.getElementById("bankSelect").disabled = locked;
}

function debugLog(message) {
    var box = document.getElementById("debugLog");

    if (!box) {
        return;
    }

    var now = new Date();
    var time =
        ("0" + now.getHours()).slice(-2) + ":" +
        ("0" + now.getMinutes()).slice(-2) + ":" +
        ("0" + now.getSeconds()).slice(-2);

    box.value += "[" + time + "] " + message + "\n";
    box.scrollTop = box.scrollHeight;
}

function clearDebugLog() {
    var box = document.getElementById("debugLog");

    if (box) {
        box.value = "";
    }
}

function toggleDebug() {
    var box = document.getElementById("debugLog");
    var btn = document.getElementById("debugToggle");

    if (!box) {
        return;
    }

    var open = box.style.display === "block";
    box.style.display = open ? "none" : "block";
    btn.textContent = open ? "Hiện debug log" : "Ẩn debug log";
}

function sleep(ms) {
    return new Promise(function (resolve) {
        window.setTimeout(resolve, ms);
    });
}

function browserHeaders(headers) {
    var blocked = {
        "user-agent": true,
        referer: true,
        origin: true,
        cookie: true,
        host: true
    };
    var clean = {};
    var names = Object.keys(headers || {});

    for (var i = 0; i < names.length; i++) {
        if (!blocked[names[i].toLowerCase()]) {
            clean[names[i]] = headers[names[i]];
        }
    }

    return clean;
}

function unwrapText(text) {
    var trimmed = String(text || "").replace(/^\uFEFF/, "").trim();

    if (!trimmed) {
        return "";
    }

    if (trimmed.charAt(0) === "{" || trimmed.charAt(0) === "[") {
        return trimmed;
    }

    var fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);

    if (fence) {
        return fence[1].trim();
    }

    var objectAt = trimmed.indexOf("\n{");
    var arrayAt = trimmed.indexOf("\n[");
    var at = objectAt === -1 ? arrayAt : (arrayAt === -1 ? objectAt : Math.min(objectAt, arrayAt));

    if (at >= 0) {
        return trimmed.slice(at + 1).trim();
    }

    return trimmed;
}

function jinaErrorMessage(text) {
    try {
        var data = JSON.parse(text);
    } catch (e) {
        return "";
    }

    if (!data || data.data != null || !data.message) {
        return "";
    }

    if (data.name === "AbuseAlleviationError" || data.code >= 400) {
        return data.readableMessage || data.message;
    }

    return "";
}

async function directRequest(method, url, headers, body) {
    var options = {
        method: method,
        headers: browserHeaders(headers),
        credentials: "omit"
    };

    if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) {
        options.signal = AbortSignal.timeout(25000);
    }

    if (body != null) {
        options.body = body;
    }

    var response = await fetch(url, options);
    var text = await response.text();

    return {
        status: response.status,
        responseText: text
    };
}

async function jinaGet(url) {
    debugLog("Đọc qua Jina vì trình duyệt không gọi thẳng được: " + url);

    var response = await fetch("https://r.jina.ai/" + url, {
        method: "GET",
        headers: {
            Accept: "text/plain",
            "X-Return-Format": "text"
        },
        credentials: "omit"
    });
    var text = unwrapText(await response.text());
    var jinaMessage = jinaErrorMessage(text);

    if (jinaMessage) {
        throw new Error(jinaMessage);
    }

    return {
        status: response.ok ? 200 : response.status,
        responseText: text
    };
}

async function callProxy(payload) {
    debugLog("Gọi proxy: " + payload.op);

    var response = await fetch(PROXY_URL, {
        method: "POST",
        headers: {
            "Content-Type": "text/plain;charset=utf-8"
        },
        body: JSON.stringify(payload),
        credentials: "omit"
    });
    var text = unwrapText(await response.text());
    var data;

    try {
        data = JSON.parse(text);
    } catch (e) {
        throw new Error("Proxy không trả về JSON");
    }

    if (!data || typeof data.status !== "number") {
        throw new Error(data && data.body ? data.body : "Proxy trả về dữ liệu không hợp lệ");
    }

    return {
        status: data.status,
        responseText: data.body || ""
    };
}

async function httpGet(url) {
    try {
        return await directRequest("GET", url, { Accept: "application/json, text/plain, */*" }, null);
    } catch (error) {
        debugLog("GET trực tiếp lỗi: " + (error.message || error));
        return jinaGet(url);
    }
}

async function httpPost(url, headers, body, proxyPayload) {
    try {
        return await directRequest("POST", url, headers, body);
    } catch (error) {
        debugLog("POST trực tiếp lỗi: " + (error.message || error));

        if (PROXY_URL && proxyPayload) {
            return callProxy(proxyPayload);
        }

        throw new Error("VietinBank chỉ nhận request từ trang của họ, trình duyệt bị chặn (CORS).");
    }
}

function parseJson(text, source) {
    try {
        return JSON.parse(unwrapText(text));
    } catch (e) {
        debugLog(source + " — không parse được: " + String(text).slice(0, 300));
        throw new Error("Không đọc được JSON từ " + source);
    }
}

function ensureOk(response, source) {
    if (response.status < 200 || response.status >= 300) {
        debugLog(source + " HTTP " + response.status + " " + String(response.responseText).slice(0, 240));
        throw new Error("HTTP " + response.status);
    }
}

function trimTrailingZero(value) {
    var text = String(value).replace(/^\s+|\s+$/g, "");

    if (/^\d+\.0+$/.test(text)) {
        return text.replace(/\.0+$/, "");
    }

    return text;
}

function requirePair(buy, sell) {
    if (buy == null || sell == null || buy === "" || sell === "") {
        throw new Error("Không tìm thấy tỷ giá USD chuyển khoản");
    }

    return {
        buy: buy,
        sell: sell
    };
}

async function getAcbRates(dateStr) {
    var iso = toApiDate(dateStr).isoDate + "T23:59:59.999";
    var url =
        "https://acb.com.vn/api/front/v1/currency" +
        "?currency=VND&effectiveDateTime=" +
        encodeURIComponent(iso);

    debugLog("ACB " + dateStr + " " + url);

    var response = await httpGet(url);
    ensureOk(response, "ACB");

    var data = parseJson(response.responseText, "ACB");
    var buy = "N/A";
    var sell = "N/A";

    if (!Array.isArray(data)) {
        throw new Error("Không đọc được JSON từ ACB");
    }

    for (var i = 0; i < data.length; i++) {
        var item = data[i];

        if (item.exchangeCurrency === "USD" && item.dealType === "BID" && item.instrumentType === "TRANSFER") {
            buy = item.exchangeRate;
        }

        if (item.exchangeCurrency === "USD" && item.dealType === "ASK" && item.instrumentType === "TRANSFER") {
            sell = item.exchangeRate;
        }
    }

    debugLog("ACB BUY=" + buy + " SELL=" + sell);

    if (buy === "N/A" && sell === "N/A") {
        throw new Error("Không tìm thấy tỷ giá USD");
    }

    return {
        buy: buy,
        sell: sell
    };
}

async function getVcbRates(dateStr) {
    var isoDate = toApiDate(dateStr).isoDate;
    var url = "https://www.vietcombank.com.vn/api/exchangerates?date=" + isoDate;

    debugLog("VCB " + dateStr + " " + url);

    var response = await httpGet(url);
    ensureOk(response, "Vietcombank");

    var result = parseJson(response.responseText, "Vietcombank");
    var buy = null;
    var sell = null;
    var rows = result && result.Data ? result.Data : [];

    for (var i = 0; i < rows.length; i++) {
        if (rows[i].currencyCode === "USD") {
            buy = trimTrailingZero(rows[i].transfer);
            sell = trimTrailingZero(rows[i].sell);
            break;
        }
    }

    debugLog("VCB BUY=" + buy + " SELL=" + sell);

    if (buy == null || sell == null || buy === "" || sell === "") {
        throw new Error("Không tìm thấy tỷ giá USD");
    }

    return {
        buy: buy,
        sell: sell
    };
}

function extractMbToken(html) {
    var match = String(html).match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/);

    if (!match) {
        match = String(html).match(/value="([^"]+)"[^>]*name="__RequestVerificationToken"/);
    }

    return match ? match[1] : "";
}

async function loadBankTable(bank) {
    if (bankTables[bank]) {
        return bankTables[bank];
    }

    var response = await fetch("data/" + bank + ".json?t=" + Math.floor(Date.now() / 3600000));

    if (!response.ok) {
        throw new Error("Không tải được dữ liệu " + bankMeta(bank).name);
    }

    bankTables[bank] = await response.json();
    return bankTables[bank];
}

async function rateFromTable(bank, dateStr) {
    var isoDate = toApiDate(dateStr).isoDate;
    var table = await loadBankTable(bank);

    if (!Object.prototype.hasOwnProperty.call(table, isoDate)) {
        return null;
    }

    var row = table[isoDate];

    if (!row || row.buy == null || row.buy === "" || row.sell == null || row.sell === "") {
        throw new Error(row && row.error
            ? row.error
            : "Không có tỷ giá " + bankMeta(bank).name + " cho ngày này");
    }

    debugLog(bankMeta(bank).name + " BUY=" + row.buy + " SELL=" + row.sell);
    return {
        buy: String(row.buy),
        sell: String(row.sell)
    };
}

async function getMbRates(dateStr) {
    debugLog("MB " + dateStr);

    var saved = await rateFromTable("mb", dateStr);

    if (saved) {
        return saved;
    }

    throw new Error("Không có tỷ giá MB cho ngày này");
}

function readMbPayload(text) {
    var result = parseJson(text, "MB");
    var buy = null;
    var sell = null;
    var rows = result && result.lst ? result.lst : [];

    for (var i = 0; i < rows.length; i++) {
        if (rows[i].currencyCode === "USD") {
            buy = rows[i].buy_bank_transfer;
            sell = rows[i].sell_bank_transfer;
            break;
        }
    }

    debugLog("MB BUY=" + buy + " SELL=" + sell);
    return requirePair(buy, sell);
}

function normalizeBidvRate(value) {
    var text = String(value == null ? "" : value).replace(/^\s+|\s+$/g, "");

    if (!text || text === "-") {
        return "";
    }

    return text.replace(/,/g, "");
}

function pickBidvSlot(list) {
    var latest = list[0];

    for (var i = 1; i < list.length; i++) {
        if (Number(list[i].time) > Number(latest.time)) {
            latest = list[i];
        }
    }

    return latest;
}

async function getBidvRates(dateStr) {
    var dateInfo = toApiDate(dateStr);
    var bidvDate = dateInfo.day + "/" + dateInfo.month + "/" + dateInfo.year;
    var headers = {
        Accept: "application/json, text/plain, */*",
        "Content-Type": "application/x-www-form-urlencoded"
    };

    debugLog("BIDV " + dateStr);

    var timesResponse = await httpPost(
        "https://bidv.com.vn/ServicesBIDV/ExchangeDetailSearchTimeServlet",
        headers,
        "date=" + encodeURIComponent(bidvDate)
    );

    ensureOk(timesResponse, "BIDV");

    var times = parseJson(timesResponse.responseText, "BIDV");

    if (!times || times.status !== 1 || !times.data || !times.data.length) {
        throw new Error("Không có tỷ giá BIDV cho ngày này");
    }

    var slot = pickBidvSlot(times.data);
    debugLog("BIDV lần " + slot.time + " lúc " + slot.hour);

    var detailResponse = await httpPost(
        "https://bidv.com.vn/ServicesBIDV/ExchangeDetailServlet",
        headers,
        "date=" + encodeURIComponent(bidvDate) + "&time=" + encodeURIComponent(slot.namerecord)
    );

    ensureOk(detailResponse, "BIDV");

    var result = parseJson(detailResponse.responseText, "BIDV");
    var buy = null;
    var sell = null;
    var rows = result && result.data ? result.data : [];

    for (var i = 0; i < rows.length; i++) {
        if (rows[i].currency === "USD") {
            buy = normalizeBidvRate(rows[i].muaCk);
            sell = normalizeBidvRate(rows[i].ban);
            break;
        }
    }

    debugLog("BIDV BUY=" + buy + " SELL=" + sell);
    return requirePair(buy, sell);
}

function stbRateValue(value) {
    if (value == null || value === "" || value === 0 || value === "0") {
        return "";
    }

    return String(value);
}

async function getStbRates(dateStr) {
    var saved = null;

    try {
        saved = await rateFromTable("stb", dateStr);
    } catch (error) {
        if (error.message && error.message.indexOf("Không tải được") === 0) {
            debugLog("Sacombank dữ liệu lưu: " + error.message);
        } else {
            throw error;
        }
    }

    if (saved) {
        return saved;
    }

    var isoDate = toApiDate(dateStr).isoDate;
    var versionsUrl =
        "https://www.sacombank.com.vn/cong-cu/ty-gia/" +
        "_jcr_content.sacom.exchange-rate.versions." +
        isoDate +
        ".json";

    debugLog("Sacombank " + dateStr);

    var versionsResponse = await httpGet(versionsUrl);
    ensureOk(versionsResponse, "Sacombank");

    var versions = parseJson(versionsResponse.responseText, "Sacombank");

    if (!versions || versions.statusCode !== 200 || !versions.data || !versions.data.length) {
        throw new Error("Không có tỷ giá Sacombank cho ngày này");
    }

    var latestTime = versions.data[0];
    debugLog("Sacombank khung giờ " + latestTime);

    var rateUrl =
        "https://www.sacombank.com.vn/cong-cu/ty-gia/" +
        "_jcr_content.sacom.exchange-rate." +
        isoDate + "." +
        encodeURIComponent(latestTime) +
        ".json";

    var rateResponse = await httpGet(rateUrl);
    ensureOk(rateResponse, "Sacombank");

    var result = parseJson(rateResponse.responseText, "Sacombank");
    var buy = null;
    var sell = null;
    var rows = result && result.statusCode === 200 && result.data ? result.data : [];

    for (var i = 0; i < rows.length; i++) {
        if (rows[i].currencyCode === "USD") {
            buy = stbRateValue(rows[i].bidInTransfer);
            sell = stbRateValue(rows[i].offerInTransfer);
            break;
        }
    }

    debugLog("Sacombank BUY=" + buy + " SELL=" + sell);
    return requirePair(buy, sell);
}

function parseVtbPayload(text) {
    var match = String(text).match(/(?:^|\n)1:(\[[\s\S]*\])\s*$/);

    if (!match) {
        return null;
    }

    try {
        return JSON.parse(match[1]);
    } catch (e) {
        return null;
    }
}

function latestVtbSlot(list) {
    var best = list[0];

    for (var i = 1; i < list.length; i++) {
        if (String(list[i].apply_date) > String(best.apply_date)) {
            best = list[i];
        }
    }

    return best;
}

function vtbRateValue(value) {
    if (value == null || value === "" || value === 0 || value === "0") {
        return "";
    }

    return trimTrailingZero(value);
}

async function postVtb(action, body) {
    return httpPost(
        "https://www.vietinbank.vn/ca-nhan/ty-gia-khcn",
        {
            Accept: "text/x-component",
            "Content-Type": "text/plain;charset=UTF-8",
            "Next-Action": action
        },
        body,
        {
            op: "vtb",
            action: action,
            body: body
        }
    );
}

function readVtbActions(js) {
    var timeName = js.match(/eB:function\(\)\{return ([A-Za-z_$][\w$]*)\}/);
    var rateName = js.match(/OQ:function\(\)\{return ([A-Za-z_$][\w$]*)\}/);

    if (!timeName || !rateName) {
        return null;
    }

    function hashOf(name) {
        var escaped = name.replace(/\$/g, "\\$");
        var found = js.match(new RegExp(
            escaped + "=\\(0,[A-Za-z_$][\\w$]*\\.\\$\\)\\(\"([a-f0-9]{40})\"\\)"
        ));

        return found ? found[1] : "";
    }

    var times = hashOf(timeName[1]);
    var rates = hashOf(rateName[1]);

    if (!times || !rates) {
        return null;
    }

    return {
        times: times,
        rates: rates
    };
}

function extractVtbChunks(html) {
    var re = /\/_next\/static\/chunks\/[^"'\\\s>]+\.js/g;
    var found = [];
    var seen = {};
    var match;

    while ((match = re.exec(html)) !== null) {
        if (!seen[match[0]]) {
            seen[match[0]] = true;
            found.push("https://www.vietinbank.vn" + match[0]);
        }
    }

    return found;
}

async function discoverVtbActions() {
    debugLog("VietinBank — tìm lại mã server action");

    var page = await httpGet("https://www.vietinbank.vn/ca-nhan/ty-gia-khcn");
    ensureOk(page, "VietinBank");

    var chunks = extractVtbChunks(page.responseText);

    for (var i = 0; i < chunks.length; i++) {
        var chunk = await httpGet(chunks[i]);

        if (chunk.status < 200 || chunk.status >= 300) {
            continue;
        }

        if (chunk.responseText.indexOf("eB:function(){return") === -1) {
            continue;
        }

        var actions = readVtbActions(chunk.responseText);

        if (actions) {
            vtbActions = actions;
            debugLog("VietinBank — đã cập nhật mã API");
            return actions;
        }
    }

    throw new Error("Không tìm thấy API VietinBank");
}

async function requestVtbRates(dateStr) {
    debugLog("VietinBank " + dateStr);

    var saved = await rateFromTable("vtb", dateStr);

    if (saved) {
        return saved;
    }

    throw new Error("Không có tỷ giá VietinBank cho ngày này");
}

async function getBankRates(bank, dateStr) {
    if (bank === "acb") {
        return getAcbRates(dateStr);
    }

    if (bank === "vcb") {
        return getVcbRates(dateStr);
    }

    if (bank === "mb") {
        return getMbRates(dateStr);
    }

    if (bank === "bidv") {
        return getBidvRates(dateStr);
    }

    if (bank === "stb") {
        return getStbRates(dateStr);
    }

    if (bank === "vtb") {
        return requestVtbRates(dateStr, false);
    }

    throw new Error("Ngân hàng không hợp lệ");
}

function showLoading(total) {
    var overlay = document.getElementById("loading");
    overlay.style.display = "block";
    document.getElementById("loadingProgress").max = total;
    document.getElementById("loadingProgress").value = 0;
    document.getElementById("loadingPercent").textContent = "0%";
    document.getElementById("loadingText").textContent = "Đang chuẩn bị lấy tỷ giá...";
}

function hideLoading() {
    document.getElementById("loading").style.display = "none";
}

function updateLoading(current, total, dateStr) {
    var percent = Math.round(current / total * 100);

    document.getElementById("loadingText").textContent =
        "Đang lấy tỷ giá " + current + "/" + total + "\n" + dateStr;
    document.getElementById("loadingProgress").value = current;
    document.getElementById("loadingPercent").textContent = percent + "%";
}

function emptyRowHtml() {
    return "Chưa có dữ liệu.<br>Chọn ngân hàng, dán ngày, rồi bấm <b>Lấy tỷ giá</b>.";
}

function clearResultsTable() {
    var tbody = document.getElementById("resultBody");
    tbody.innerHTML = "";

    var tr = document.createElement("tr");
    tr.id = "emptyRow";

    var td = document.createElement("td");
    td.colSpan = 3;
    td.className = "empty";
    td.innerHTML = emptyRowHtml();
    tr.appendChild(td);
    tbody.appendChild(tr);
    document.getElementById("resultCount").textContent = "0 dòng";
}

function addResultRow(dateStr, buy, sell) {
    var tbody = document.getElementById("resultBody");
    var emptyRow = document.getElementById("emptyRow");

    if (emptyRow) {
        tbody.removeChild(emptyRow);
    }

    var tr = document.createElement("tr");
    var tdDate = document.createElement("td");
    var tdBuy = document.createElement("td");
    var tdSell = document.createElement("td");

    tdDate.textContent = dateStr;
    tdBuy.textContent = buy;
    tdSell.textContent = sell;
    tr.appendChild(tdDate);
    tr.appendChild(tdBuy);
    tr.appendChild(tdSell);
    tbody.appendChild(tr);

    var count = tbody.querySelectorAll("tr").length;
    document.getElementById("resultCount").textContent = count + " dòng";
}

function updateMainProgress(current, total) {
    document.getElementById("progress").value = current;
    document.getElementById("status").textContent =
        "Đã xử lý " + current + "/" + total + " (" + Math.round(current / total * 100) + "%)";
}

function finishRun(dates, errors) {
    running = false;
    document.getElementById("run").disabled = false;
    document.getElementById("stop").disabled = true;
    setBankLocked(false);
    hideLoading();

    if (cancelled) {
        document.getElementById("status").textContent = "Đã dừng.";
        return;
    }

    if (errors.length) {
        document.getElementById("status").textContent =
            "Hoàn tất — " + dates.length + " dòng, " + errors.length + " lỗi.";
        window.alert("Có lỗi khi gọi " + activeBankName + ":\n\n" + errors.join("\n"));
        return;
    }

    document.getElementById("status").textContent =
        "Hoàn tất — " + dates.length + " dòng. Ngày trùng chỉ gọi API một lần.";
}

async function run() {
    if (running) {
        return;
    }

    var dates = parseDates(document.getElementById("input").value);

    if (!dates.length) {
        window.alert("Không tìm thấy ngày hợp lệ dạng DD/MM/YYYY.");
        return;
    }

    running = true;
    cancelled = false;
    applyBankLabels(document.getElementById("bankSelect").value);
    document.getElementById("run").disabled = true;
    document.getElementById("stop").disabled = false;
    setBankLocked(true);
    clearResultsTable();
    results = [];

    var cache = {};
    var errors = [];
    var bank = activeBank;

    showLoading(dates.length);
    document.getElementById("progress").max = dates.length;
    document.getElementById("progress").value = 0;
    document.getElementById("status").textContent = "Đang chuẩn bị...";

    for (var index = 0; index < dates.length; index++) {
        if (cancelled) {
            break;
        }

        var dateStr = dates[index];
        var current = index + 1;

        updateLoading(current, dates.length, dateStr);
        document.getElementById("status").textContent =
            "Đang lấy " + current + "/" + dates.length + " — " + dateStr;

        var rate;
        var fromCache = Object.prototype.hasOwnProperty.call(cache, dateStr);

        if (fromCache) {
            rate = cache[dateStr];
        } else {
            try {
                rate = await getBankRates(bank, dateStr);
            } catch (error) {
                rate = {
                    buy: "Lỗi",
                    sell: "Lỗi"
                };
                errors.push(dateStr + ": " + (error.message || error));
            }

            cache[dateStr] = rate;
        }

        if (cancelled) {
            break;
        }

        results.push([dateStr, rate.buy, rate.sell]);
        addResultRow(dateStr, rate.buy, rate.sell);
        updateMainProgress(current, dates.length);

        if (!fromCache && index < dates.length - 1) {
            await sleep(200);
        }
    }

    finishRun(dates, errors);
}

function cancelRun() {
    if (!running) {
        return;
    }

    cancelled = true;
    document.getElementById("status").textContent = "Đang dừng...";
}

function copyWithSelection(text) {
    var area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "0";
    area.style.left = "0";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.focus();
    area.select();
    area.setSelectionRange(0, area.value.length);

    var ok = false;

    try {
        ok = document.execCommand("copy");
    } catch (e) {
        ok = false;
    }

    document.body.removeChild(area);
    return ok;
}

async function writeClipboard(text) {
    if (copyWithSelection(text)) {
        return;
    }

    if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return;
    }

    throw new Error("copy");
}

async function copyResults() {
    if (!results.length) {
        window.alert("Chưa có kết quả.");
        return;
    }

    var lines = ["Ngày\t" + activeBuyLabel + "\t" + activeSellLabel];

    for (var i = 0; i < results.length; i++) {
        lines.push(results[i][0] + "\t" + results[i][1] + "\t" + results[i][2]);
    }

    try {
        await writeClipboard(lines.join("\r\n"));
        window.alert("Đã copy dữ liệu.\nCó thể Ctrl+V trực tiếp vào Excel.");
    } catch (e) {
        window.alert("Không tự copy được.\nHãy chọn dữ liệu trong bảng rồi Ctrl+C.");
    }
}

async function copyColumn(colIndex) {
    if (!results.length) {
        window.alert("Chưa có kết quả.");
        return;
    }

    var lines = [];

    for (var i = 0; i < results.length; i++) {
        lines.push(results[i][colIndex]);
    }

    var label = colIndex === 1 ? activeBuyLabel : activeSellLabel;

    try {
        await writeClipboard(lines.join("\r\n"));
        document.getElementById("status").textContent =
            "Đã copy cột " + label + " (" + lines.length + " dòng). Ctrl+V để dán vào Excel.";
    } catch (e) {
        window.alert("Không tự copy được.\nHãy chọn dữ liệu trong cột rồi Ctrl+C.");
    }
}

function clearAll() {
    if (running) {
        window.alert("Đang lấy dữ liệu. Hãy bấm Dừng trước.");
        return;
    }

    document.getElementById("input").value = "";
    clearResultsTable();
    document.getElementById("progress").value = 0;
    document.getElementById("status").textContent = "Sẵn sàng";
    results = [];
}

window.addEventListener("load", function () {
    document.getElementById("loading").style.display = "none";
    clearResultsTable();
    onBankChanged();
});
