/*
 * 対応仕様:
 * - RS-274X 基本コマンド
 * - 単位指定: MOMM / MOIN
 * - 座標形式指定: FS（先頭/末尾ゼロ省略）
 * - 絶対座標 / インクリメンタル座標
 * - 円形アパーチャ C
 * - 矩形アパーチャ R
 * - オーバルアパーチャ O
 * - 正多角形アパーチャ P
 * - D01: 描画
 * - D02: 移動
 * - D03: フラッシュ
 * - G01: 直線補間
 * - G36 / G37: 領域描画
 * - LPD / LPC: 描画極性
 * - 基本的な穴あき円形アパーチャ
 * - Excellonの基本的なドリル座標
 *
 * 未対応または制限あり:
 * - Gerberマクロ AM
 * - 複雑なマクロアパーチャ
 * - Excellonのスロット加工
 * - 一部の拡張仕様
 *
 * 注意:実際の製造データに対する完全な互換性は保証しません。
 */

(function () {
    "use strict";

    const VERSION = "1.3.0";

    /*
     * 公開API
     *
     * window.gerberToSvg(data, options, callback)
     *
     * callback(error, svgString)
     */

    function gerberToSvg(input, options, callback) {
        if (typeof options === "function") {
            callback = options;
            options = {};
        }

        options = options || {};

        const done = typeof callback === "function"
            ? callback
            : function () {};

        try {
            const svg = convertGerber(
                String(input || ""),
                options
            );

            done(null, svg);
        } catch (error) {
            done(
                error instanceof Error
                    ? error
                    : new Error(String(error))
            );
        }
    }

    function convertGerber(source, options) {
        if (/^\uFEFF?\s*M48(?:\s|$)/i.test(source)) {
            return convertExcellon(source, options);
        }

        let unit = "mm";

        let formatXInt = 2;
        let formatXDec = 4;
        let formatYInt = 2;
        let formatYDec = 4;
        let zeroSuppression = "leading";

        let absoluteCoordinates = true;

        let currentX = 0;
        let currentY = 0;

        let previousX = 0;
        let previousY = 0;

        let currentDCode = 10;
        let currentOperation = 2;
        let currentInterpolation = "linear";

        let currentPolarity = "dark";

        let regionMode = false;
        let regionPoints = [];

        let quadrantMode = "multi";

        const apertures = Object.create(null);
        const shapes = [];

        const bounds = {
            minX: Infinity,
            minY: Infinity,
            maxX: -Infinity,
            maxY: -Infinity
        };

        const outputColor = escapeXml(
            options.color || "#ffffff"
        );

        function unitScale() {
            return unit === "inch" ? 25.4 : 1;
        }

        function fmt(value) {
            if (!Number.isFinite(value)) {
                return "0";
            }

            const rounded = Number(
                value.toFixed(10)
            );

            if (Object.is(rounded, -0)) {
                return "0";
            }

            return rounded.toString();
        }

        function normalizeGerberParameter(parameter) {
            return String(parameter || "")
                .replace(/\s+/g, "")
                .trim();
        }

        function updateBounds(
            x,
            y,
            paddingX,
            paddingY
        ) {
            paddingX = paddingX || 0;

            paddingY = paddingY === undefined
                ? paddingX
                : paddingY;

            bounds.minX = Math.min(
                bounds.minX,
                x - paddingX
            );

            bounds.maxX = Math.max(
                bounds.maxX,
                x + paddingX
            );

            bounds.minY = Math.min(
                bounds.minY,
                y - paddingY
            );

            bounds.maxY = Math.max(
                bounds.maxY,
                y + paddingY
            );
        }

        function getAperture() {
            const aperture = apertures[currentDCode];
            if (!aperture) {
                throw new Error(
                    `D${currentDCode} のアパーチャが定義されていません。`
                );
            }
            return aperture;
        }

        /*
         * Gerber座標値を実寸へ変換
         */
        function parseCoordinate(
            raw,
            integerDigits,
            decimalDigits
        ) {
            const cleaned = String(raw || "").trim();

            if (cleaned === "") {
                return null;
            }

            const normalized = cleaned.replace(
                /\s+/g,
                ""
            );

            if (normalized.includes(".")) {
                const value = Number(normalized);
                return Number.isFinite(value)
                    ? value * unitScale()
                    : null;
            }

            const negative = normalized.startsWith("-");

            const digits = normalized.replace(/^[+-]/, "");

            const totalDigits =
                integerDigits + decimalDigits;

            const padded = zeroSuppression === "trailing"
                ? digits.padEnd(totalDigits, "0")
                : digits.padStart(totalDigits, "0");

            let value =
                Number(padded) /
                Math.pow(10, decimalDigits);

            if (negative) {
                value = -value;
            }

            return value * unitScale();
        }

        /*
         * アパーチャ定義の読み込み
         */
        function defineAperture(parameter) {
            const match = parameter.match(
                /^ADD(\d+)([A-Z][A-Z0-9_]*),?(.+)?$/
            );

            if (!match) {
                return;
            }

            const code = Number(match[1]);
            const type = match[2];

            const rawParameters = (
                match[3] || ""
            ).split("X");

            const values = rawParameters.map(
                value => Number(value) * unitScale()
            );

            if (type === "C") {
                apertures[code] = {
                    type: "C",
                    x: values[0] || 0.2,
                    y: values[0] || 0.2,
                    hole: values[1] || 0
                };

                return;
            }

            if (type === "R") {
                apertures[code] = {
                    type: "R",
                    x: values[0] || 0.2,
                    y: values[1] || values[0] || 0.2,
                    hole: values[2] || 0
                };

                return;
            }

            if (type === "O") {
                apertures[code] = {
                    type: "O",
                    x: values[0] || 0.2,
                    y: values[1] || values[0] || 0.2,
                    hole: values[2] || 0
                };

                return;
            }

            if (type === "P") {
                apertures[code] = {
                    type: "P",
                    x: values[0] || 0.2,
                    y: values[0] || 0.2,

                    vertices: Math.max(
                        3,
                        Math.min(
                            100,
                            Number(rawParameters[1]) || 6
                        )
                    ),

                    rotation: Number(
                        rawParameters[2]
                    ) || 0,

                    hole: values[3] || 0
                };

                return;
            }

            throw new Error(
                `アパーチャ形状 ${type} は未対応です。`
            );
        }

        /*
         * アパーチャの寸法の取得
         */
        function getApertureBounds(aperture) {
            const width = aperture.x || 0.2;
            const height = aperture.y || width;

            return {
                width,
                height,
                radius: Math.max(width, height) / 2
            };
        }

        /*
         * フラッシュ登録
         */
        function addFlash(x, y, aperture) {
            const dimensions = getApertureBounds(
                aperture
            );

            updateBounds(
                x,
                y,
                dimensions.width / 2,
                dimensions.height / 2
            );

            shapes.push({
                type: "flash",
                x,
                y,
                aperture: Object.assign(
                    {},
                    aperture
                ),
                polarity: currentPolarity
            });
        }

        /*
         * 配線の直線区間を登録
         */
        function addStroke(
            x1,
            y1,
            x2,
            y2,
            aperture
        ) {
            const width = aperture.x || 0.2;
            const height = aperture.y || width;

            const strokeWidth = Math.max(
                width,
                height
            );

            const padding = strokeWidth / 2;

            updateBounds(
                x1,
                y1,
                padding,
                padding
            );

            updateBounds(
                x2,
                y2,
                padding,
                padding
            );

            shapes.push({
                type: "stroke",

                x1,
                y1,
                x2,
                y2,

                aperture: Object.assign(
                    {},
                    aperture
                ),

                polarity: currentPolarity
            });
        }

        function normalizeArcDelta(delta) {
            const twoPi = Math.PI * 2;
            let value = delta % twoPi;
            if (value < 0) {
                value += twoPi;
            }
            return value;
        }

        function addArc(
            x1,
            y1,
            x2,
            y2,
            centerX,
            centerY,
            clockwise,
            aperture
        ) {
            if (!Number.isFinite(x1) || !Number.isFinite(y1) ||
                !Number.isFinite(x2) || !Number.isFinite(y2) ||
                !Number.isFinite(centerX) || !Number.isFinite(centerY)) {
                addStroke(x1, y1, x2, y2, aperture);
                return;
            }

            const radius = Math.hypot(x1 - centerX, y1 - centerY);
            if (!Number.isFinite(radius) || radius <= 0) {
                addStroke(x1, y1, x2, y2, aperture);
                return;
            }

            const startAngle = Math.atan2(y1 - centerY, x1 - centerX);
            const endAngle = Math.atan2(y2 - centerY, x2 - centerX);
            const delta = clockwise
                ? normalizeArcDelta(endAngle - startAngle)
                : normalizeArcDelta(startAngle - endAngle);

            const largeArc = delta > Math.PI ? 1 : 0;
            const sweep = clockwise ? 1 : 0;

            const width = aperture.x || 0.2;
            const height = aperture.y || width;
            const strokeWidth = Math.max(width, height);
            const padding = strokeWidth / 2;

            updateBounds(x1, y1, padding, padding);
            updateBounds(x2, y2, padding, padding);
            updateBounds(centerX, centerY, radius + padding, radius + padding);

            shapes.push({
                type: "arc",
                x1,
                y1,
                x2,
                y2,
                radius,
                largeArc,
                sweep,
                centerX,
                centerY,
                aperture: Object.assign({}, aperture),
                polarity: currentPolarity
            });
        }
        /*
         * 領域を登録
         */
        function finishRegion() {
            if (regionPoints.length >= 3) {
                for (const point of regionPoints) {
                    updateBounds(
                        point[0],
                        point[1],
                        0,
                        0
                    );
                }

                shapes.push({
                    type: "region",

                    points: regionPoints.map(
                        point => [
                            point[0],
                            point[1]
                        ]
                    ),

                    polarity: currentPolarity
                });
            }

            regionPoints = [];
        }

        /*
         * 座標移動・描画・フラッシュ処理
         */
        function processOperation(
            newX,
            newY,
            operation,
            arcSpec
        ) {
            previousX = currentX;
            previousY = currentY;

            if (newX !== null) {
                if (absoluteCoordinates) {
                    currentX = newX;
                } else {
                    currentX += newX;
                }
            }

            if (newY !== null) {
                if (absoluteCoordinates) {
                    currentY = newY;
                } else {
                    currentY += newY;
                }
            }

            /*
             * 領域描画中
             */
            if (regionMode) {
                if (options.omitRegions) {
                    return;
                }

                if (operation === 2) {
                    if (regionPoints.length >= 3) {
                        finishRegion();
                    }

                    regionPoints = [
                        [currentX, currentY]
                    ];

                } else if (operation === 1) {
                    regionPoints.push([
                        currentX,
                        currentY
                    ]);
                }

                return;
            }

            if (
                options.omitNonRegions &&
                currentPolarity === "dark"
            ) {
                return;
            }

            /*
             * D02: 移動
             */
            if (operation === 2) {
                return;
            }

            const aperture = getAperture();

            /*
             * D01: 描画
             */
            if (operation === 1) {
                if (arcSpec) {
                    addArc(
                        previousX,
                        previousY,
                        currentX,
                        currentY,
                        arcSpec.centerX,
                        arcSpec.centerY,
                        arcSpec.clockwise,
                        aperture
                    );
                    return;
                }

                addStroke(
                    previousX,
                    previousY,
                    currentX,
                    currentY,
                    aperture
                );

                return;
            }

            /*
             * D03: フラッシュ
             */
            if (operation === 3) {
                addFlash(
                    currentX,
                    currentY,
                    aperture
                );
            }
        }

        function handleInterpolation(token) {
            if (/^G0?2(?:$|[^0-9])/.test(token)) {
                currentInterpolation = "clockwise";
                return;
            }

            if (/^G0?3(?:$|[^0-9])/.test(token)) {
                currentInterpolation = "counterclockwise";
                return;
            }

            if (/^G0?1(?:$|[^0-9])/.test(token)) {
                currentInterpolation = "linear";
            }
        }

        function tokenizeGerber(text) {
            const input = String(text).replace(/\r/g, "");
            const result = [];

            let normal = "";
            let extended = "";
            let inExtended = false;

            for (let i = 0; i < input.length; i++) {
                const ch = input[i];

                if (ch === "%") {
                    if (!inExtended) {
                        if (normal.trim()) {
                            result.push(normal.trim());
                        }

                        normal = "";
                        extended = "";
                        inExtended = true;

                    } else {
                        if (extended.trim()) {
                            result.push(
                                "%" + extended.trim() + "%"
                            );
                        }

                        extended = "";
                        inExtended = false;
                    }

                    continue;
                }

                if (ch === "*" && inExtended) {
                    if (extended.trim()) {
                        result.push(
                            "%" + extended.trim() + "%"
                        );
                    }

                    extended = "";
                    continue;
                }

                if (ch === "*" && !inExtended) {
                    if (normal.trim()) {
                        result.push(normal.trim());
                    }

                    normal = "";
                    continue;
                }

                if (inExtended) {
                    extended += ch;
                } else {
                    normal += ch;
                }
            }

            if (inExtended) {
                throw new Error(
                    "Gerber拡張コマンドの終端 % がありません。"
                );
            }

            if (normal.trim()) {
                result.push(normal.trim());
            }

            return result;
        }

        const tokens = tokenizeGerber(source);

        for (let token of tokens) {
            token = token.trim();

            if (!token) {
                continue;
            }

            /*
             * コメント
             */
            if (/^G04/.test(token)) {
                continue;
            }

            /*
             * 拡張パラメータ
             */
            if (
                token.startsWith("%") &&
                token.endsWith("%")
            ) {
                const parameter = normalizeGerberParameter(
                    token.slice(1, -1)
                );

                /*
                 * 単位指定
                 */
                if (/^MOMM/.test(parameter)) {
                    unit = "mm";
                    continue;
                }

                if (/^MOIN/.test(parameter)) {
                    unit = "inch";
                    continue;
                }

                /*
                 * 座標形式指定
                 */
                const formatMatch = parameter.match(
                    /^FS([LT])([AI])X(\d)(\d)Y(\d)(\d)(?:.*)$/
                );

                if (formatMatch) {
                    zeroSuppression = formatMatch[1] === "T"
                        ? "trailing"
                        : "leading";
                    formatXInt = Number(formatMatch[3]);
                    formatXDec = Number(formatMatch[4]);
                    formatYInt = Number(formatMatch[5]);
                    formatYDec = Number(formatMatch[6]);

                    absoluteCoordinates =
                        formatMatch[2] === "A";

                    continue;
                }

                /*
                 * アパーチャ定義
                 */
                if (/^ADD/.test(parameter)) {
                    defineAperture(parameter);
                    continue;
                }

                /*
                 * 描画極性
                 */
                if (parameter === "LPD") {
                    currentPolarity = "dark";
                    continue;
                }

                if (parameter === "LPC") {
                    currentPolarity = "clear";
                    continue;
                }

                /*
                 * 未使用のマクロ定義は読み飛ばす
                 * ADDで参照の未対応形状は defineAperture でエラー
                 */
                if (/^AM/.test(parameter)) {
                    continue;
                }

                continue;
            }

            /*
             * 領域描画開始
             */
            if (token === "G36") {
                regionMode = true;
                regionPoints = [];
                continue;
            }

            /*
             * 領域描画終了
             */
            if (token === "G37") {
                finishRegion();
                regionMode = false;
                continue;
            }

            /*
             * 円弧補間モード
             */
            if (/^G0?[23]/.test(token)) {
                handleInterpolation(token);
            }

            /*
             * 直線補間モード
             */
            token = token.replace(/^G0?1/, "");

            /*
             * 座標取得
             */
            const xMatch = token.match(
                /X([+-]?(?:\d+\.?\d*|\.\d+))/
            );

            const yMatch = token.match(
                /Y([+-]?(?:\d+\.?\d*|\.\d+))/
            );

            const iMatch = token.match(
                /I([+-]?(?:\d+\.?\d*|\.\d+))/
            );

            const jMatch = token.match(
                /J([+-]?(?:\d+\.?\d*|\.\d+))/
            );

            const rMatch = token.match(
                /R([+-]?(?:\d+\.?\d*|\.\d+))/
            );

            /*
             * D01 / D02 / D03
             */
            const operationMatch = token.match(
                /D0?([123])(?:$|[^0-9])/ 
            );

            /*
             * D10以降のアパーチャ選択
             */
            const apertureMatch = token.match(
                /D(\d{2,})/
            );

            if (
                apertureMatch &&
                Number(apertureMatch[1]) >= 10
            ) {
                currentDCode = Number(
                    apertureMatch[1]
                );
            }

            /*
             * 座標変換
             */
            const x = xMatch
                ? parseCoordinate(
                    xMatch[1],
                    formatXInt,
                    formatXDec
                )
                : null;

            const y = yMatch
                ? parseCoordinate(
                    yMatch[1],
                    formatYInt,
                    formatYDec
                )
                : null;

            const i = iMatch
                ? parseCoordinate(
                    iMatch[1],
                    formatXInt,
                    formatXDec
                )
                : null;

            const j = jMatch
                ? parseCoordinate(
                    jMatch[1],
                    formatYInt,
                    formatYDec
                )
                : null;

            const radiusValue = rMatch
                ? parseCoordinate(
                    rMatch[1],
                    formatXInt,
                    formatXDec
                )
                : null;

            let operation = null;

            if (operationMatch) {
                operation = Number(
                    operationMatch[1]
                );

            } else if (xMatch || yMatch) {
                operation = currentOperation;
            }

            let arcSpec = null;
            if (
                operation === 1 &&
                currentInterpolation !== "linear" &&
                (x !== null || y !== null) &&
                (i !== null || j !== null || radiusValue !== null)
            ) {
                const startX = currentX;
                const startY = currentY;
                const endX = x !== null
                    ? (absoluteCoordinates ? x : currentX + x)
                    : currentX;
                const endY = y !== null
                    ? (absoluteCoordinates ? y : currentY + y)
                    : currentY;

                const clockwise = currentInterpolation === "clockwise";

                if (i !== null || j !== null) {
                    arcSpec = {
                        centerX: i !== null ? startX + i : endX,
                        centerY: j !== null ? startY + j : endY,
                        clockwise
                    };
                } else if (radiusValue !== null) {
                    const dx = endX - startX;
                    const dy = endY - startY;
                    const distance = Math.hypot(dx, dy);
                    const radiusAbs = Math.abs(radiusValue);

                    if (distance > 0 && radiusAbs > 0) {
                        const halfDistance = distance / 2;
                        const height = Math.sqrt(
                            Math.max(0, radiusAbs * radiusAbs - halfDistance * halfDistance)
                        );
                        const midX = (startX + endX) / 2;
                        const midY = (startY + endY) / 2;
                        const sign = clockwise ? 1 : -1;
                        const ux = distance > 0 ? -dy / distance : 0;
                        const uy = distance > 0 ? dx / distance : 0;

                        arcSpec = {
                            centerX: midX + sign * height * ux,
                            centerY: midY + sign * height * uy,
                            clockwise
                        };
                    }
                }
            }

            if (operation !== null) {
                currentOperation = operation;

                processOperation(
                    x,
                    y,
                    operation,
                    arcSpec
                );
            }
        }

        if (regionMode) {
            finishRegion();
        }

        /*
         * 描画対象が存在しない場合
         */
        if (!Number.isFinite(bounds.minX)) {
            return [
                '<svg xmlns="http://www.w3.org/2000/svg"',
                ' viewBox="0 0 1 1"',
                ' width="1mm" height="1mm"></svg>'
            ].join("");
        }

        /*
         * SVG表示範囲
         */
        const padding = Math.max(
            bounds.maxX - bounds.minX,
            bounds.maxY - bounds.minY,
            1
        ) * 0.005;

        const viewBox = options.viewBox;
        const useViewBox =
            viewBox &&
            Number.isFinite(viewBox.minX) &&
            Number.isFinite(viewBox.minY) &&
            Number.isFinite(viewBox.width) &&
            Number.isFinite(viewBox.height) &&
            viewBox.width > 0 &&
            viewBox.height > 0;
        const minX = useViewBox
            ? viewBox.minX
            : bounds.minX - padding;
        const minY = useViewBox
            ? viewBox.minY
            : bounds.minY - padding;

        const width = useViewBox
            ? viewBox.width
            : Math.max(
                bounds.maxX - bounds.minX + padding * 2,
                0.001
            );

        const height = useViewBox
            ? viewBox.height
            : Math.max(
                bounds.maxY - bounds.minY + padding * 2,
                0.001
            );
        const flipAxis = Number.isFinite(options.flipAxis)
            ? options.flipAxis
            : minY * 2 + height;

        const maskId = "gerber-mask";

        const output = [];

        output.push(
            `<svg xmlns="http://www.w3.org/2000/svg"`,
            ` viewBox="${fmt(minX)} ${fmt(minY)} ${fmt(width)} ${fmt(height)}"`,
            ` width="${fmt(width)}mm"`,
            ` height="${fmt(height)}mm"`,
            ` preserveAspectRatio="xMidYMid meet"`,
            ` shape-rendering="geometricPrecision">`
        );

        output.push("<defs>");

        output.push(
            `<mask id="${maskId}"`,
            ` style="mask-type:luminance"`,
            ` maskUnits="userSpaceOnUse"`,
            ` x="${fmt(minX)}"`,
            ` y="${fmt(minY)}"`,
            ` width="${fmt(width)}"`,
            ` height="${fmt(height)}">`
        );

        output.push(
            `<rect x="${fmt(minX)}"`,
            ` y="${fmt(minY)}"`,
            ` width="${fmt(width)}"`,
            ` height="${fmt(height)}"`,
            ` fill="black"/>`
        );

        output.push(
            `<g transform="translate(0 ${fmt(flipAxis)}) scale(1 -1)">`
        );

        /*
         * 極性処理用マスク
         */
        for (const shape of shapes) {
            output.push(
                renderShape(
                    shape,
                    shape.polarity === "dark"
                        ? "white"
                        : "black",
                    fmt
                )
            );
        }

        output.push("</g>");
        output.push("</mask>");
        output.push("</defs>");

        /*
         * 描画対象をマスク付き出力
         */
        output.push(
            `<rect x="${fmt(minX)}"`,
            ` y="${fmt(minY)}"`,
            ` width="${fmt(width)}"`,
            ` height="${fmt(height)}"`,
            ` fill="${outputColor}"`,
            ` mask="url(#${maskId})"/>`
        );

        output.push("</svg>");

        return ensureValidSvg(output.join(""), {
            minX,
            minY,
            width,
            height
        });
    }

    function convertExcellon(source, options) {
        let unit = "mm";
        let integerDigits = 2;
        let decimalDigits = 4;
        let zeroSuppression = "leading";
        // EAGLE emits leading-zero-suppressed coordinates despite its TZ header.
        const isEagleOutput =
            /^;GenerationSoftware,[^,\r\n]*,EAGLE(?:,|\*|$)/im.test(source);
        let absoluteCoordinates = true;
        let currentTool = null;
        let currentX = 0;
        let currentY = 0;

        const tools = Object.create(null);
        const holes = [];
        const outputColor = escapeXml(
            options.color || "#ffffff"
        );

        function unitScale() {
            return unit === "inch" ? 25.4 : 1;
        }

        function fmt(value) {
            if (!Number.isFinite(value)) {
                return "0";
            }

            const rounded = Number(value.toFixed(10));
            return Object.is(rounded, -0) ? "0" : rounded.toString();
        }

        function parseCoordinate(raw) {
            const normalized = raw.replace(/\s+/g, "");
            if (normalized.includes(".")) {
                const value = Number(normalized);
                return Number.isFinite(value)
                    ? value * unitScale()
                    : null;
            }

            const negative = normalized.startsWith("-");
            const digits = normalized.replace(/^[+-]/, "");
            const totalDigits = integerDigits + decimalDigits;
            const padded = zeroSuppression === "trailing"
                ? digits.padEnd(totalDigits, "0")
                : digits.padStart(totalDigits, "0");
            let value = Number(padded) / Math.pow(10, decimalDigits);

            if (negative) {
                value = -value;
            }

            return Number.isFinite(value)
                ? value * unitScale()
                : null;
        }

        for (const [index, rawLine] of String(source).split(/\r?\n/).entries()) {
            const line = rawLine.replace(/;.*$/, "").trim();

            if (!line || /^M48$/i.test(line) || /^M30$/i.test(line) ||
                /^M95$/i.test(line) || line === "%") {
                continue;
            }

            const unitMatch = line.match(
                /^(METRIC|INCH)(?:,(TZ|LZ))?(?:,(\d+)\.(\d+))?/i
            );

            if (unitMatch) {
                unit = unitMatch[1].toUpperCase() === "INCH"
                    ? "inch"
                    : "mm";

                if (unitMatch[2]) {
                    zeroSuppression = isEagleOutput
                        ? "leading"
                        : unitMatch[2].toUpperCase() === "TZ"
                            ? "trailing"
                            : "leading";
                }

                if (unitMatch[3]) {
                    integerDigits = unitMatch[3].length;
                    decimalDigits = unitMatch[4].length;
                }

                continue;
            }

            const toolDefinition = line.match(
                /^T(\d+)C([+-]?(?:\d+\.?\d*|\.\d+))/i
            );

            if (toolDefinition) {
                tools[Number(toolDefinition[1])] =
                    Number(toolDefinition[2]) * unitScale();
                continue;
            }

            const toolSelection = line.match(/^T(\d+)/i);
            if (toolSelection) {
                currentTool = Number(toolSelection[1]);
            }

            if (/^ICI,ON$/i.test(line) || /^G91$/i.test(line)) {
                absoluteCoordinates = false;
                continue;
            }

            if (/^ICI,OFF$/i.test(line) || /^G90$/i.test(line)) {
                absoluteCoordinates = true;
                continue;
            }

            const xMatch = line.match(
                /X([+-]?(?:\d+\.?\d*|\.\d+))/i
            );
            const yMatch = line.match(
                /Y([+-]?(?:\d+\.?\d*|\.\d+))/i
            );

            if (!xMatch && !yMatch) {
                continue;
            }

            if (currentTool === null || !tools[currentTool]) {
                throw new Error(
                    `Excellon ${index + 1}行目: 有効なドリル工具が選択されていません。`
                );
            }

            const x = xMatch ? parseCoordinate(xMatch[1]) : null;
            const y = yMatch ? parseCoordinate(yMatch[1]) : null;

            if ((xMatch && x === null) || (yMatch && y === null)) {
                throw new Error(
                    `Excellon ${index + 1}行目: 座標を読み取れません。`
                );
            }

            currentX = x === null
                ? currentX
                : absoluteCoordinates ? x : currentX + x;
            currentY = y === null
                ? currentY
                : absoluteCoordinates ? y : currentY + y;

            holes.push({
                x: currentX,
                y: currentY,
                diameter: tools[currentTool]
            });
        }

        if (!holes.length) {
            return [
                '<svg xmlns="http://www.w3.org/2000/svg"',
                ' viewBox="0 0 1 1"',
                ' width="1mm" height="1mm"></svg>'
            ].join("");
        }

        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;

        for (const hole of holes) {
            const radius = hole.diameter / 2;
            minX = Math.min(minX, hole.x - radius);
            minY = Math.min(minY, hole.y - radius);
            maxX = Math.max(maxX, hole.x + radius);
            maxY = Math.max(maxY, hole.y + radius);
        }

        const padding = Math.max(maxX - minX, maxY - minY, 1) * 0.005;
        minX -= padding;
        minY -= padding;
        const width = maxX - minX + padding;
        const height = maxY - minY + padding;

        const circles = holes.map(hole =>
            `<circle cx="${fmt(hole.x)}" cy="${fmt(hole.y)}" ` +
            `r="${fmt(hole.diameter / 2)}"/>`
        ).join("");

        return [
            '<svg xmlns="http://www.w3.org/2000/svg"',
            ` viewBox="${fmt(minX)} ${fmt(minY)} ${fmt(width)} ${fmt(height)}"`,
            ` width="${fmt(width)}mm" height="${fmt(height)}mm"`,
            ' preserveAspectRatio="xMidYMid meet"',
            ' shape-rendering="geometricPrecision">',
            `<g transform="translate(0 ${fmt(minY * 2 + height)}) scale(1 -1)" fill="${outputColor}">${circles}</g>`,
            '</svg>'
        ].join("");
    }

    function ensureValidSvg(svgText, fallback) {
        let svg = String(svgText || "").trim();

        if (!svg) {
            return [
                '<svg xmlns="http://www.w3.org/2000/svg"',
                ` viewBox="${fmt((fallback && Number.isFinite(fallback.minX)) ? fallback.minX : 0)} ${fmt((fallback && Number.isFinite(fallback.minY)) ? fallback.minY : 0)} ${fmt((fallback && Number.isFinite(fallback.width)) ? fallback.width : 1)} ${fmt((fallback && Number.isFinite(fallback.height)) ? fallback.height : 1)}"`,
                ' width="1mm" height="1mm"></svg>'
            ].join("");
        }

        svg = svg.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");

        if (!/<svg\b/i.test(svg)) {
            const minX = fallback && Number.isFinite(fallback.minX) ? fallback.minX : 0;
            const minY = fallback && Number.isFinite(fallback.minY) ? fallback.minY : 0;
            const width = fallback && Number.isFinite(fallback.width) ? fallback.width : 1;
            const height = fallback && Number.isFinite(fallback.height) ? fallback.height : 1;

            return [
                '<svg xmlns="http://www.w3.org/2000/svg"',
                ` viewBox="${fmt(minX)} ${fmt(minY)} ${fmt(width)} ${fmt(height)}"`,
                ' width="1mm" height="1mm"></svg>'
            ].join("");
        }

        if (!/<\/svg\s*>\s*$/i.test(svg)) {
            svg += "</svg>";
        }

        return svg;
    }

    /*
     * 図形をSVGへ変換
     */
    function renderShape(shape, color, fmt) {
        if (shape.type === "stroke") {
            const aperture = shape.aperture;

            const strokeWidth = Math.max(
                aperture.x || 0.2,
                aperture.y || aperture.x || 0.2
            );

            let output = (
                `<path d="M ${fmt(shape.x1)} ${fmt(shape.y1)} ` +
                `L ${fmt(shape.x2)} ${fmt(shape.y2)}" ` +
                `fill="none" ` +
                `stroke="${color}" ` +
                `stroke-width="${fmt(strokeWidth)}" ` +
                `stroke-linecap="round" ` +
                `stroke-linejoin="round"/>`
            );

            if (aperture.hole > 0) {
                output += (
                    `<path d="M ${fmt(shape.x1)} ${fmt(shape.y1)} ` +
                    `L ${fmt(shape.x2)} ${fmt(shape.y2)}" ` +
                    `fill="none" ` +
                    `stroke="${color === "white" ? "black" : "white"}" ` +
                    `stroke-width="${fmt(aperture.hole)}" ` +
                    `stroke-linecap="round" ` +
                    `stroke-linejoin="round"/>`
                );
            }

            return output;
        }

        if (shape.type === "arc") {
            const radius = Math.max(shape.radius || 0, 0.0001);
            const startX = fmt(shape.x1);
            const startY = fmt(shape.y1);
            const endX = fmt(shape.x2);
            const endY = fmt(shape.y2);
            const largeArcFlag = shape.largeArc || 0;
            const sweepFlag = shape.sweep || 0;

            return (
                `<path d="M ${startX} ${startY} A ${fmt(radius)} ${fmt(radius)} 0 ${largeArcFlag} ${sweepFlag} ${endX} ${endY}" ` +
                `fill="none" ` +
                `stroke="${color}" ` +
                `stroke-width="${fmt(Math.max(shape.aperture.x || 0.2, shape.aperture.y || shape.aperture.x || 0.2))}" ` +
                `stroke-linecap="round" ` +
                `stroke-linejoin="round"/>`
            );
        }

        if (shape.type === "region") {
            const points = shape.points
                .map(point => (
                    `${fmt(point[0])},${fmt(point[1])}`
                ))
                .join(" ");

            return (
                `<polygon points="${points}" ` +
                `fill="${color}" ` +
                `stroke="none"/>`
            );
        }

        if (shape.type === "flash") {
            return renderFlash(
                shape,
                color,
                fmt
            );
        }

        return "";
    }

        /*
     * フラッシュ形状をSVGへ変換
     */
    function renderFlash(shape, color, fmt) {
        const aperture = shape.aperture;

        const x = shape.x;
        const y = shape.y;

        const width = aperture.x || 0.2;
        const height = aperture.y || width;

        let result = "";

        /*
         * 円形アパーチャ
         */
        if (aperture.type === "C") {
            result = [
                `<circle cx="${fmt(x)}"`,
                ` cy="${fmt(y)}"`,
                ` r="${fmt(width / 2)}"`,
                ` fill="${color}"/>`
            ].join("");
        }

        /*
         * 矩形アパーチャ
         */
        else if (aperture.type === "R") {
            result = [
                `<rect x="${fmt(x - width / 2)}"`,
                ` y="${fmt(y - height / 2)}"`,
                ` width="${fmt(width)}"`,
                ` height="${fmt(height)}"`,
                ` fill="${color}"/>`
            ].join("");
        }

        /*
         * オーバルアパーチャ
         */
        else if (aperture.type === "O") {
            const radius = Math.min(
                width,
                height
            ) / 2;

            result = [
                `<rect x="${fmt(x - width / 2)}"`,
                ` y="${fmt(y - height / 2)}"`,
                ` width="${fmt(width)}"`,
                ` height="${fmt(height)}"`,
                ` rx="${fmt(radius)}"`,
                ` ry="${fmt(radius)}"`,
                ` fill="${color}"/>`
            ].join("");
        }

        /*
         * 正多角形アパーチャ
         */
        else if (aperture.type === "P") {
            const vertices = aperture.vertices || 6;

            const rotation = (
                aperture.rotation || 0
            ) * Math.PI / 180;

            const points = [];

            for (let i = 0; i < vertices; i++) {
                const angle =
                    rotation +
                    2 * Math.PI * i / vertices;

                points.push(
                    `${fmt(x + width / 2 * Math.cos(angle))},` +
                    `${fmt(y + width / 2 * Math.sin(angle))}`
                );
            }

            result = [
                `<polygon points="${points.join(" ")}"`,
                ` fill="${color}"/>`
            ].join("");
        }

        /*
         * 不明なアパーチャは円形として扱う
         */
        else {
            result = [
                `<circle cx="${fmt(x)}"`,
                ` cy="${fmt(y)}"`,
                ` r="${fmt(width / 2)}"`,
                ` fill="${color}"/>`
            ].join("");
        }

        /*
         * 穴あきアパーチャ
         */
        if (aperture.hole > 0) {
            const hole = fmt(aperture.hole);

            result += [
                `<circle cx="${fmt(x)}"`,
                ` cy="${fmt(y)}"`,
                ` r="${fmt(Number(hole) / 2)}"`,
                ` fill="${color === "white" ? "black" : "white"}"/>`
            ].join("");
        }

        return result;
    }

    /*
     * XMLエスケープ
     */
    function escapeXml(value) {
        return String(value)
            .replace(/&/g, "&amp;")
            .replace(/"/g, "&quot;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
    }

    /*
     * 公開
     */
    window.gerberToSvg = gerberToSvg;
    window.gerberSvgConverterVersion = VERSION;

})();