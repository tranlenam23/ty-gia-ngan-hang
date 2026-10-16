/* Phục vụ web tĩnh và chuyển tiếp VietinBank.
   Trình duyệt không gọi thẳng được trang ngân hàng (CORS),
   nên request đi qua máy này với Origin của VietinBank. */
var http = require("http");
var fs = require("fs");
var path = require("path");

var ROOT = path.join(__dirname, "..");
var PORT = 8787;
var VTB_URL = "https://www.vietinbank.vn/ty-gia-khdn";

var types = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".txt": "text/plain; charset=utf-8"
};

function sendJson(res, status, data) {
    var body = JSON.stringify(data);

    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Private-Network": "true",
        "Content-Length": Buffer.byteLength(body)
    });
    res.end(body);
}

function safeFile(urlPath) {
    var decoded = decodeURIComponent(urlPath.split("?")[0]);

    if (decoded === "/") {
        decoded = "/index.html";
    }

    var file = path.normalize(path.join(ROOT, decoded));

    if (file !== ROOT && file.indexOf(ROOT + path.sep) !== 0) {
        return "";
    }

    return file;
}

async function forwardVtb(payload) {
    var action = payload && payload.action;
    var body = payload && payload.body;

    if (!/^[a-f0-9]{40}$/.test(String(action || ""))) {
        return { status: 400, body: "Mã API VietinBank không hợp lệ" };
    }

    if (typeof body !== "string" || body.length > 200 || body.charAt(0) !== "[") {
        return { status: 400, body: "Nội dung request VietinBank không hợp lệ" };
    }

    var response = await fetch(VTB_URL, {
        method: "POST",
        headers: {
            Accept: "text/x-component",
            "Content-Type": "text/plain;charset=UTF-8",
            "Next-Action": action,
            Origin: "https://www.vietinbank.vn",
            Referer: VTB_URL
        },
        body: body
    });
    var text = await response.text();

    return {
        status: response.status,
        body: text
    };
}

var server = http.createServer(function (req, res) {
    var urlPath = (req.url || "/").split("?")[0];

    if (urlPath === "/api/vtb" && req.method === "OPTIONS") {
        res.writeHead(204, {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
            "Access-Control-Allow-Private-Network": "true"
        });
        res.end();
        return;
    }

    if (urlPath === "/api/vtb" && req.method === "POST") {
        var chunks = [];
        var size = 0;

        req.on("data", function (chunk) {
            size += chunk.length;

            if (size > 10000) {
                res.destroy();
                return;
            }

            chunks.push(chunk);
        });

        req.on("end", function () {
            var payload;

            try {
                payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            } catch (e) {
                sendJson(res, 400, { status: 400, body: "JSON không hợp lệ" });
                return;
            }

            forwardVtb(payload).then(function (result) {
                sendJson(res, 200, result);
            }).catch(function (error) {
                sendJson(res, 200, {
                    status: 502,
                    body: error.message || String(error)
                });
            });
        });

        return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405);
        res.end();
        return;
    }

    var file = safeFile(req.url || "/");

    if (!file) {
        res.writeHead(403);
        res.end();
        return;
    }

    fs.readFile(file, function (error, data) {
        if (error) {
            res.writeHead(404);
            res.end("Not found");
            return;
        }

        res.writeHead(200, {
            "Content-Type": types[path.extname(file).toLowerCase()] || "application/octet-stream"
        });

        if (req.method === "HEAD") {
            res.end();
            return;
        }

        res.end(data);
    });
});

server.listen(PORT, "127.0.0.1", function () {
    console.log("Web tỷ giá: http://127.0.0.1:" + PORT);
});
