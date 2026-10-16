/* Tỷ giá USD — bản web của công cụ HTA.
   Để trống nếu chưa có Apps Script trung gian cho MB và VietinBank. */
var bankTables = {};

var results = [];
var slotCache = {};
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
            hint: "BIDV: Mua = USD chuyển khoản, Bán = USD bán. Mặc định là lần công bố mới nhất. Bấm nút cạnh ngày để chọn lần khác."
        };
    }

    if (bank === "stb") {
        return {
            name: "Sacombank",
            buy: "Mua chuyển khoản",
            sell: "Bán chuyển khoản",
            hint: "Sacombank: Mua = USD chuyển khoản, Bán = USD chuyển khoản. Mặc định là khung giờ mới nhất. Bấm nút cạnh ngày để chọn giờ khác."
        };
    }

    if (bank === "vtb") {
        return {
            name: "VietinBank",
            buy: "Mua chuyển khoản",
            sell: "Bán chuyển khoản",
            hint: "VietinBank: Mua = USD chuyển khoản, Bán = USD bán. Mặc định là khung giờ mới nhất. Bấm nút cạnh ngày để chọn giờ khác."
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

    return readProxyResponse(response);
}

async function httpGet(url) {
    try {
        return await directRequest("GET", url, { Accept: "application/json, text/plain, */*" }, null);
    } catch (error) {
        debugLog("GET trực tiếp lỗi: " + (error.message || error));
        return jinaGet(url);
    }
}

async function readProxyResponse(response) {
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

async function callLocalVtb(payload) {
    var endpoints = ["/api/vtb", "http://127.0.0.1:8787/api/vtb"];
    var lastError = null;
    var i;

    for (i = 0; i < endpoints.length; i++) {
        try {
            debugLog("VietinBank — gọi qua máy cục bộ: " + endpoints[i]);

            var response = await fetch(endpoints[i], {
                method: "POST",
                headers: {
                    "Content-Type": "text/plain;charset=utf-8"
                },
                body: JSON.stringify(payload),
                credentials: "omit"
            });

            if (!response.ok) {
                throw new Error("HTTP " + response.status);
            }

            return await readProxyResponse(response);
        } catch (error) {
            lastError = error;
            debugLog("Proxy cục bộ lỗi: " + (error.message || error));
        }
    }

    throw lastError || new Error("Không kết nối được proxy VietinBank");
}

async function httpPost(url, headers, body, proxyPayload) {
    try {
        return await directRequest("POST", url, headers, body);
    } catch (error) {
        debugLog("POST trực tiếp lỗi: " + (error.message || error));

        if (proxyPayload && proxyPayload.op === "vtb") {
            return callLocalVtb(proxyPayload);
        }

        if (typeof PROXY_URL !== "undefined" && PROXY_URL && proxyPayload) {
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

function mapBidvSlots(list) {
    var slots = [];
    var i;

    for (i = 0; i < list.length; i++) {
        slots.push({
            id: String(list[i].namerecord),
            label: "Lần " + list[i].time + " · " + list[i].hour,
            time: Number(list[i].time)
        });
    }

    slots.sort(function (a, b) {
        return b.time - a.time;
    });

    return slots;
}

function bidvHeaders() {
    return {
        Accept: "application/json, text/plain, */*",
        "Content-Type": "application/x-www-form-urlencoded"
    };
}

async function loadBidvSlots(dateStr) {
    var bidvDate = toApiDate(dateStr);
    var day = bidvDate.day + "/" + bidvDate.month + "/" + bidvDate.year;

    debugLog("BIDV danh sách lần " + dateStr);

    var timesResponse = await httpPost(
        "https://bidv.com.vn/ServicesBIDV/ExchangeDetailSearchTimeServlet",
        bidvHeaders(),
        "date=" + encodeURIComponent(day)
    );

    ensureOk(timesResponse, "BIDV");

    var times = parseJson(timesResponse.responseText, "BIDV");

    if (!times || times.status !== 1 || !times.data || !times.data.length) {
        throw new Error("Không có tỷ giá BIDV cho ngày này");
    }

    return mapBidvSlots(times.data);
}

async function fetchBidvBySlot(dateStr, slotId) {
    var bidvDate = toApiDate(dateStr);
    var day = bidvDate.day + "/" + bidvDate.month + "/" + bidvDate.year;

    debugLog("BIDV lần " + slotId);

    var detailResponse = await httpPost(
        "https://bidv.com.vn/ServicesBIDV/ExchangeDetailServlet",
        bidvHeaders(),
        "date=" + encodeURIComponent(day) + "&time=" + encodeURIComponent(slotId)
    );

    ensureOk(detailResponse, "BIDV");

    var result = parseJson(detailResponse.responseText, "BIDV");
    var buy = null;
    var sell = null;
    var rows = result && result.data ? result.data : [];
    var i;

    for (i = 0; i < rows.length; i++) {
        if (rows[i].currency === "USD") {
            buy = normalizeBidvRate(rows[i].muaCk);
            sell = normalizeBidvRate(rows[i].ban);
            break;
        }
    }

    debugLog("BIDV BUY=" + buy + " SELL=" + sell);
    return requirePair(buy, sell);
}

async function getBidvRates(dateStr) {
    var bidvDate = toApiDate(dateStr);
    var day = bidvDate.day + "/" + bidvDate.month + "/" + bidvDate.year;

    debugLog("BIDV " + dateStr);

    var timesResponse = await httpPost(
        "https://bidv.com.vn/ServicesBIDV/ExchangeDetailSearchTimeServlet",
        bidvHeaders(),
        "date=" + encodeURIComponent(day)
    );

    ensureOk(timesResponse, "BIDV");

    var times = parseJson(timesResponse.responseText, "BIDV");

    if (!times || times.status !== 1 || !times.data || !times.data.length) {
        throw new Error("Không có tỷ giá BIDV cho ngày này");
    }

    var slot = pickBidvSlot(times.data);
    var slots = mapBidvSlots(times.data);

    debugLog("BIDV lần " + slot.time + " lúc " + slot.hour);

    var rate = await fetchBidvBySlot(dateStr, String(slot.namerecord));

    rate.slots = slots;
    rate.slotId = String(slot.namerecord);
    rate.slotsLoaded = true;
    rate.slotConfirmed = true;
    return rate;
}

function stbRateValue(value) {
    if (value == null || value === "" || value === 0 || value === "0") {
        return "";
    }

    return String(value);
}

function mapStbSlots(list) {
    var slots = [];
    var i;

    for (i = 0; i < list.length; i++) {
        slots.push({
            id: String(list[i]),
            label: String(list[i])
        });
    }

    return slots;
}

async function loadStbSlots(dateStr) {
    var isoDate = toApiDate(dateStr).isoDate;
    var versionsUrl =
        "https://www.sacombank.com.vn/cong-cu/ty-gia/" +
        "_jcr_content.sacom.exchange-rate.versions." +
        isoDate +
        ".json";

    debugLog("Sacombank danh sách giờ " + dateStr);

    var versionsResponse = await httpGet(versionsUrl);
    ensureOk(versionsResponse, "Sacombank");

    var versions = parseJson(versionsResponse.responseText, "Sacombank");

    if (!versions || versions.statusCode !== 200 || !versions.data || !versions.data.length) {
        throw new Error("Không có tỷ giá Sacombank cho ngày này");
    }

    return mapStbSlots(versions.data);
}

async function fetchStbBySlot(dateStr, slotId) {
    var isoDate = toApiDate(dateStr).isoDate;
    var rateUrl =
        "https://www.sacombank.com.vn/cong-cu/ty-gia/" +
        "_jcr_content.sacom.exchange-rate." +
        isoDate + "." +
        encodeURIComponent(slotId) +
        ".json";

    debugLog("Sacombank khung giờ " + slotId);

    var rateResponse = await httpGet(rateUrl);
    ensureOk(rateResponse, "Sacombank");

    var result = parseJson(rateResponse.responseText, "Sacombank");
    var buy = null;
    var sell = null;
    var rows = result && result.statusCode === 200 && result.data ? result.data : [];
    var i;

    for (i = 0; i < rows.length; i++) {
        if (rows[i].currencyCode === "USD") {
            buy = stbRateValue(rows[i].bidInTransfer);
            sell = stbRateValue(rows[i].offerInTransfer);
            break;
        }
    }

    debugLog("Sacombank BUY=" + buy + " SELL=" + sell);
    return requirePair(buy, sell);
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
        saved.slotsLoaded = false;
        return saved;
    }

    debugLog("Sacombank " + dateStr);

    var slots = await loadStbSlots(dateStr);
    var latestTime = slots[0].id;

    debugLog("Sacombank khung giờ " + latestTime);

    var rate = await fetchStbBySlot(dateStr, latestTime);

    rate.slots = slots;
    rate.slotId = latestTime;
    rate.slotsLoaded = true;
    rate.slotConfirmed = true;
    return rate;
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

function vtbClockLabel(applyDate) {
    var text = String(applyDate);
    var at = text.indexOf("T");
    var clock = at >= 0 ? text.substring(at + 1) : text;

    if (clock.length >= 5) {
        return clock.substring(0, 5);
    }

    return clock;
}

function mapVtbSlots(list) {
    var slots = [];
    var counts = {};
    var i;

    for (i = 0; i < list.length; i++) {
        slots.push({
            id: String(list[i].apply_date),
            label: vtbClockLabel(list[i].apply_date),
            time: String(list[i].apply_date)
        });
    }

    slots.sort(function (a, b) {
        if (a.time === b.time) {
            return 0;
        }

        return a.time < b.time ? 1 : -1;
    });

    for (i = 0; i < slots.length; i++) {
        counts[slots[i].label] = (counts[slots[i].label] || 0) + 1;
    }

    for (i = 0; i < slots.length; i++) {
        if (counts[slots[i].label] > 1) {
            var at = slots[i].id.indexOf("T");
            slots[i].label = at >= 0 ? slots[i].id.substring(at + 1) : slots[i].id;
        }
    }

    return slots;
}

async function readVtbList(action, body) {
    var response = await postVtb(action, body);

    if (response.status >= 200 && response.status < 300) {
        var parsed = parseVtbPayload(response.responseText);

        if (parsed) {
            return parsed;
        }
    }

    await discoverVtbActions();

    response = await postVtb(action, body);
    ensureOk(response, "VietinBank");

    var retried = parseVtbPayload(response.responseText);

    if (!retried) {
        throw new Error("Không đọc được dữ liệu VietinBank");
    }

    return retried;
}

async function loadVtbSlots(dateStr) {
    var isoDate = toApiDate(dateStr).isoDate;

    debugLog("VietinBank danh sách giờ " + dateStr);

    var list = await readVtbList(vtbActions.times, "[\"" + isoDate + "\"]");

    if (!list || !list.length) {
        throw new Error("Không có tỷ giá VietinBank cho ngày này");
    }

    return mapVtbSlots(list);
}

async function fetchVtbBySlot(slotId) {
    debugLog("VietinBank khung giờ " + slotId);

    var rows = await readVtbList(
        vtbActions.rates,
        "[\"" + slotId + "\",[\"USD\"]]"
    );
    var buy = null;
    var sell = null;
    var i;

    rows = rows || [];

    for (i = 0; i < rows.length; i++) {
        if (rows[i].currency_code === "USD") {
            buy = vtbRateValue(rows[i].transfer_rate);
            sell = vtbRateValue(rows[i].sell_rate);
            break;
        }
    }

    debugLog("VietinBank BUY=" + buy + " SELL=" + sell);
    return requirePair(buy, sell);
}

function vtbRateValue(value) {
    if (value == null || value === "" || value === 0 || value === "0") {
        return "";
    }

    return trimTrailingZero(value);
}

async function postVtb(action, body) {
    return httpPost(
        "https://www.vietinbank.vn/ty-gia-khdn",
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

    var page = await httpGet("https://www.vietinbank.vn/ty-gia-khdn");
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
        saved.slotsLoaded = false;
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

function bankHasSlotChoice(bank) {
    return bank === "bidv" || bank === "stb" || bank === "vtb";
}

function findSlotLabel(slots, id) {
    var i;

    if (!slots) {
        return "";
    }

    for (i = 0; i < slots.length; i++) {
        if (slots[i].id === id) {
            return slots[i].label;
        }
    }

    return "";
}

function rowNeedsSlotButton(row) {
    if (!row || row[1] === "Lỗi" || row[2] === "Lỗi") {
        return false;
    }

    if (!bankHasSlotChoice(row.bank)) {
        return false;
    }

    if (row.slotsLoaded && (!row.slots || row.slots.length < 2)) {
        return false;
    }

    return true;
}

function pushResult(dateStr, rate) {
    var row = [dateStr, rate.buy, rate.sell];

    row.bank = activeBank;
    row.slots = rate.slots || null;
    row.slotId = rate.slotId || "";
    row.slotsLoaded = !!rate.slotsLoaded;
    row.slotConfirmed = !!rate.slotConfirmed;

    if (row.slots) {
        slotCache[activeBank + "|" + dateStr] = row.slots;
    }

    results.push(row);
    addResultRow(results.length - 1);
}

function addResultRow(index) {
    var tbody = document.getElementById("resultBody");
    var emptyRow = document.getElementById("emptyRow");
    var row = results[index];
    var tr = document.createElement("tr");
    var tdDate = document.createElement("td");
    var tdBuy = document.createElement("td");
    var tdSell = document.createElement("td");
    var dateText = document.createElement("span");

    if (emptyRow) {
        tbody.removeChild(emptyRow);
    }

    tr.id = "resultRow" + index;
    tr.className = "data-row" + (index % 2 ? " alt" : "");
    tdDate.id = "dateCell" + index;
    tdBuy.id = "buyCell" + index;
    tdSell.id = "sellCell" + index;
    dateText.className = "date-text";
    dateText.textContent = row[0];
    tdBuy.textContent = row[1];
    tdSell.textContent = row[2];
    tdDate.appendChild(dateText);
    tr.appendChild(tdDate);
    tr.appendChild(tdBuy);
    tr.appendChild(tdSell);
    tbody.appendChild(tr);
    refreshSlotButton(index);
    document.getElementById("resultCount").textContent = results.length + " dòng";
}

function refreshSlotButton(index) {
    var row = results[index];
    var btn = document.getElementById("slotBtn" + index);
    var dateCell;
    var label;

    if (!rowNeedsSlotButton(row)) {
        if (btn && btn.parentNode) {
            btn.parentNode.removeChild(btn);
        }
        return;
    }

    if (!btn) {
        dateCell = document.getElementById("dateCell" + index);
        btn = document.createElement("button");
        btn.type = "button";
        btn.className = "slot-btn";
        btn.id = "slotBtn" + index;
        btn.onclick = function () {
            openSlotMenu(index);
        };
        dateCell.appendChild(btn);
    }

    label = findSlotLabel(row.slots, row.slotId);
    btn.textContent = (label || (row.bank === "bidv" ? "Chọn lần" : "Chọn giờ")) + " ▾";
    btn.disabled = !!row.loading;
    btn.title = row.bank === "bidv" ? "Chọn lần công bố khác" : "Chọn khung giờ khác";
}

function paintRowValues(index) {
    var row = results[index];
    document.getElementById("buyCell" + index).textContent = row[1];
    document.getElementById("sellCell" + index).textContent = row[2];
}

function readableSlotError(bank, error) {
    var message = error && error.message ? error.message : String(error);

    if (
        bank === "vtb" &&
        /CORS|Failed to fetch|NetworkError|chặn/i.test(message)
    ) {
        return "Trình duyệt không gọi thẳng được VietinBank. Chạy node scripts/serve.js rồi mở http://127.0.0.1:8787 — hoặc dùng app HTA.";
    }

    return message;
}

function closeSlotMenu() {
    var existing = document.getElementById("slotRow");

    if (existing && existing.parentNode) {
        existing.parentNode.removeChild(existing);
    }
}

function renderSlotMenu(index) {
    var row = results[index];
    var dataTr = document.getElementById("resultRow" + index);
    var tr = document.createElement("tr");
    var td = document.createElement("td");
    var note = document.createElement("div");
    var menu = document.createElement("div");
    var i;

    closeSlotMenu();

    tr.id = "slotRow";
    tr.className = "slot-row";
    tr.setAttribute("data-index", String(index));
    td.colSpan = 3;
    td.className = "slot-cell";
    note.className = "slot-note";
    note.textContent = row.bank === "bidv" ? "Chọn lần công bố trong ngày" : "Chọn khung giờ trong ngày";
    menu.className = "slot-menu";

    for (i = 0; i < row.slots.length; i++) {
        menu.appendChild(createSlotOption(index, row.slots[i], row.slotId));
    }

    td.appendChild(note);
    td.appendChild(menu);
    tr.appendChild(td);

    if (dataTr.nextSibling) {
        dataTr.parentNode.insertBefore(tr, dataTr.nextSibling);
    } else {
        dataTr.parentNode.appendChild(tr);
    }
}

function createSlotOption(index, slot, selectedId) {
    var button = document.createElement("button");

    button.type = "button";
    button.className = "slot-option" + (slot.id === selectedId ? " current" : "");
    button.setAttribute("data-slot", slot.id);
    button.textContent = slot.label;
    button.disabled = !!results[index].loading;
    button.onclick = function () {
        selectSlot(index, slot.id);
    };

    return button;
}

function refreshSlotMenuSelection(index) {
    var menu = document.getElementById("slotRow");
    var buttons;
    var i;
    var row;

    if (!menu || menu.getAttribute("data-index") !== String(index)) {
        return;
    }

    row = results[index];
    buttons = menu.getElementsByTagName("button");

    for (i = 0; i < buttons.length; i++) {
        buttons[i].className = "slot-option" +
            (buttons[i].getAttribute("data-slot") === row.slotId ? " current" : "");
        buttons[i].disabled = !!row.loading;
    }
}

async function loadSlotsForBank(bank, dateStr) {
    if (bank === "bidv") {
        return loadBidvSlots(dateStr);
    }

    if (bank === "stb") {
        return loadStbSlots(dateStr);
    }

    if (bank === "vtb") {
        return loadVtbSlots(dateStr);
    }

    return [];
}

async function fetchSlotRate(bank, dateStr, slotId) {
    if (bank === "bidv") {
        return fetchBidvBySlot(dateStr, slotId);
    }

    if (bank === "stb") {
        return fetchStbBySlot(dateStr, slotId);
    }

    if (bank === "vtb") {
        return fetchVtbBySlot(slotId);
    }

    throw new Error("Ngân hàng không có nhiều khung giờ");
}

async function ensureRowSlots(index) {
    var row = results[index];
    var key = row.bank + "|" + row[0];
    var slots;

    if (row.slotsLoaded && row.slots) {
        return row.slots;
    }

    if (Object.prototype.hasOwnProperty.call(slotCache, key)) {
        slots = slotCache[key];
    } else {
        slots = await loadSlotsForBank(row.bank, row[0]);
        slotCache[key] = slots;
    }

    if (results[index] !== row) {
        return slots;
    }

    row.slots = slots;
    row.slotsLoaded = true;

    if (!row.slotId && slots.length) {
        row.slotId = slots[0].id;
    }

    return slots;
}

async function openSlotMenu(index) {
    var row = results[index];
    var existing = document.getElementById("slotRow");

    if (!row || row.loading) {
        return;
    }

    if (existing && existing.getAttribute("data-index") === String(index)) {
        closeSlotMenu();
        return;
    }

    closeSlotMenu();
    row.loading = true;
    refreshSlotButton(index);

    try {
        await ensureRowSlots(index);
    } catch (error) {
        if (results[index] === row) {
            row.loading = false;
            refreshSlotButton(index);
            window.alert(row[0] + ": " + readableSlotError(row.bank, error));
        }
        return;
    }

    if (results[index] !== row) {
        return;
    }

    row.loading = false;
    refreshSlotButton(index);

    if (!row.slots || row.slots.length < 2) {
        document.getElementById("status").textContent =
            row[0] + " chỉ có một " + (row.bank === "bidv" ? "lần công bố." : "khung giờ.");
        return;
    }

    renderSlotMenu(index);
}

async function selectSlot(index, slotId) {
    var row = results[index];
    var previousBuy;
    var previousSell;
    var previousId;
    var requestId;
    var rate;

    if (!row || row.loading) {
        return;
    }

    if (row.slotId === slotId && row.slotConfirmed) {
        refreshSlotMenuSelection(index);
        return;
    }

    previousBuy = row[1];
    previousSell = row[2];
    previousId = row.slotId;
    row.loading = true;
    row.requestId = (row.requestId || 0) + 1;
    requestId = row.requestId;
    refreshSlotButton(index);
    refreshSlotMenuSelection(index);

    try {
        rate = await fetchSlotRate(row.bank, row[0], slotId);
    } catch (error) {
        if (results[index] === row && row.requestId === requestId) {
            row[1] = previousBuy;
            row[2] = previousSell;
            row.slotId = previousId;
            row.loading = false;
            paintRowValues(index);
            refreshSlotButton(index);
            refreshSlotMenuSelection(index);
            window.alert(row[0] + ": " + readableSlotError(row.bank, error));
        }
        return;
    }

    if (results[index] !== row || row.requestId !== requestId) {
        return;
    }

    row[1] = rate.buy;
    row[2] = rate.sell;
    row.slotId = slotId;
    row.slotConfirmed = true;
    row.loading = false;
    paintRowValues(index);
    refreshSlotButton(index);
    refreshSlotMenuSelection(index);
    document.getElementById("status").textContent =
        row[0] + " — " + findSlotLabel(row.slots, slotId);
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
    slotCache = {};

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

        pushResult(dateStr, rate);
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
    slotCache = {};
}

window.addEventListener("load", function () {
    document.getElementById("loading").style.display = "none";
    clearResultsTable();
    onBankChanged();
});
