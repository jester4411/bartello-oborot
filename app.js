document.addEventListener('DOMContentLoaded', () => {
    const dropZone = document.getElementById('dropZone');
    const fileInput = document.getElementById('fileInput');
    const loading = document.getElementById('loading');
    const errorDiv = document.getElementById('error');
    const results = document.getElementById('results');
    const resultBody = document.getElementById('resultBody');
    const resultsTitle = document.getElementById('resultsTitle');
    const downloadBtn = document.getElementById('downloadBtn');
    const lightSummary = document.getElementById('lightSummary');

    let currentData = null;

    // Drag and drop
    dropZone.addEventListener('click', () => fileInput.click());

    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('drag-over');
    });

    dropZone.addEventListener('dragleave', () => {
        dropZone.classList.remove('drag-over');
    });

    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('drag-over');
        const file = e.dataTransfer.files[0];
        if (file) processFile(file);
    });

    fileInput.addEventListener('change', () => {
        const file = fileInput.files[0];
        if (file) processFile(file);
    });

    downloadBtn.addEventListener('click', downloadExcel);

    function processFile(file) {
        if (!file.name.endsWith('.csv')) {
            showError('Пожалуйста, загрузите файл в формате CSV.');
            return;
        }

        loading.classList.remove('hidden');
        results.classList.add('hidden');
        errorDiv.classList.add('hidden');

        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const buffer = e.target.result;
                const text = decodeCSV(buffer);
                const rows = parseCSV(text, ';');
                currentData = aggregate(rows);
                renderTable(currentData);
                loading.classList.add('hidden');
                results.classList.remove('hidden');
            } catch (err) {
                loading.classList.add('hidden');
                showError('Ошибка обработки файла: ' + err.message);
                console.error(err);
            }
        };
        reader.readAsArrayBuffer(file);
    }

    // Try to decode as UTF-8, fallback to CP1251
    function decodeCSV(buffer) {
        const bytes = new Uint8Array(buffer);

        // Check BOM for UTF-8
        if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
            return new TextDecoder('utf-8').decode(buffer);
        }

        // Try UTF-8 first
        const utf8 = new TextDecoder('utf-8', { fatal: true });
        try {
            const text = utf8.decode(buffer);
            // Heuristic: if decoded text contains common Russian words, it's valid
            if (text.includes('Дата') || text.includes('заказ')) {
                return text;
            }
        } catch (_) {
            // Not valid UTF-8
        }

        // Fallback to CP1251
        return new TextDecoder('windows-1251').decode(buffer);
    }

    // CSV parser that handles quoted fields with newlines, semicolon delimiter
    function parseCSV(text, delimiter) {
        const rows = [];
        let i = 0;
        const len = text.length;

        while (i < len) {
            const row = [];
            while (i < len) {
                if (text[i] === '"') {
                    // Quoted field
                    i++; // skip opening quote
                    let field = '';
                    while (i < len) {
                        if (text[i] === '"') {
                            if (i + 1 < len && text[i + 1] === '"') {
                                field += '"';
                                i += 2;
                            } else {
                                i++; // skip closing quote
                                break;
                            }
                        } else {
                            field += text[i];
                            i++;
                        }
                    }
                    row.push(field);
                } else {
                    // Unquoted field
                    let field = '';
                    while (i < len && text[i] !== delimiter && text[i] !== '\n' && text[i] !== '\r') {
                        field += text[i];
                        i++;
                    }
                    row.push(field);
                }

                if (i < len && text[i] === delimiter) {
                    i++; // skip delimiter
                } else {
                    break; // end of row
                }
            }

            // Skip line endings
            if (i < len && text[i] === '\r') i++;
            if (i < len && text[i] === '\n') i++;

            rows.push(row);
        }

        return rows;
    }

    function parseNum(s) {
        if (!s || s.trim() === '') return 0;
        // Replace comma decimal separator: "4600,00" -> "4600.00"
        // Also handle "4 600,00" with spaces
        return parseFloat(s.replace(/\s/g, '').replace(',', '.')) || 0;
    }

    function aggregate(rows) {
        const venues = []; // Final ordered list of venue blocks
        const lightTotals = []; // Заказы через Бартелло Лайт — по заведениям
        let currentVenue = null;
        let ordersByPayment = {};

        // Способ оплаты + признак Бартелло Лайт → подпись строки
        function groupLabel(pmKey, isLight) {
            const base = pmKey === 'Card' ? 'К' : pmKey === 'SbpPay' ? 'SBP' : 'QR';
            return isLight ? base + ' Лайт' : base;
        }

        function finalizeVenue() {
            if (!currentVenue) return;

            const keys = Object.keys(ordersByPayment);
            const hasMultipleGroups = keys.length > 1;

            if (hasMultipleGroups) {
                // "общая" row with empty commission
                venues.push({
                    type: 'total',
                    name: currentVenue.name + ' общая',
                    legal: currentVenue.legal,
                    inn: currentVenue.inn,
                    revenue: currentVenue.revenue,
                    returns: currentVenue.returns,
                    afterReturns: currentVenue.afterReturns,
                    commission: null
                });

                // Порядок строк: сначала обычные заказы способа оплаты, следом — Лайт
                const methodOrder = ['Card', 'SbpPay'];
                for (const key of keys) {
                    const pm = ordersByPayment[key].pmKey;
                    if (!methodOrder.includes(pm)) methodOrder.push(pm);
                }

                for (const method of methodOrder) {
                    for (const isLight of [false, true]) {
                        const key = method + '|' + (isLight ? 'light' : 'main');
                        const data = ordersByPayment[key];
                        if (!data) continue;
                        venues.push({
                            type: 'sub',
                            isLight: isLight,
                            name: currentVenue.name + ' ' + groupLabel(method, isLight),
                            legal: '',
                            inn: '',
                            revenue: data.revenue,
                            returns: data.returns,
                            afterReturns: data.revenue - data.returns,
                            commission: data.commission
                        });
                    }
                }
            } else {
                // Один способ оплаты — одна строка (у «лайтовых» заведений помечаем её)
                const onlyLight = keys.length === 1 && ordersByPayment[keys[0]].isLight;
                venues.push({
                    type: 'single',
                    isLight: onlyLight,
                    name: currentVenue.name + (onlyLight ? ' Лайт' : ''),
                    legal: currentVenue.legal,
                    inn: currentVenue.inn,
                    revenue: currentVenue.revenue,
                    returns: currentVenue.returns,
                    afterReturns: currentVenue.afterReturns,
                    commission: currentVenue.commission
                });
            }

            // Итоги по Лайту для сводки над таблицей
            for (const key of keys) {
                const data = ordersByPayment[key];
                if (!data.isLight) continue;
                lightTotals.push({
                    venue: currentVenue.name,
                    label: groupLabel(data.pmKey, true),
                    orders: data.orders,
                    revenue: data.revenue,
                    afterReturns: data.revenue - data.returns,
                    commission: data.commission
                });
            }
        }

        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            if (row.length < 4) continue;

            const col0 = row[0].trim();
            const col1 = (row[1] || '').trim();
            const col2 = (row[2] || '').trim();
            const col3 = (row[3] || '').trim();

            // Skip column header rows
            if (col0 === 'Дата') continue;

            // Skip empty rows
            if (!col0 && !col1 && !col2 && !col3) continue;

            // Venue header row: name, legal, INN present, col3 empty
            if (col0 && col1 && col2 && !col3 && !col0.startsWith('20')) {
                // Finalize previous venue if exists
                finalizeVenue();

                currentVenue = {
                    name: col0,
                    legal: col1,
                    inn: col2,
                    revenue: 0,
                    returns: 0,
                    afterReturns: 0,
                    commission: 0
                };
                ordersByPayment = {};
                continue;
            }

            // Venue summary row: name, legal, INN present, col3 is a number
            if (col0 && col1 && col2 && col3 && !col0.startsWith('20') && col0 !== 'Дата') {
                const rev = parseNum(col3);
                if (rev >= 0 && currentVenue && col0 === currentVenue.name) {
                    currentVenue.revenue = rev;
                    currentVenue.returns = parseNum(row[4]);
                    currentVenue.afterReturns = parseNum(row[5]);
                    currentVenue.commission = parseNum(row[6]);
                    continue;
                }
            }

            // Order row: starts with date
            if (col0.startsWith('20') && row.length > 15 && currentVenue) {
                const paymentMethod = (row[13] || '').trim();
                if (!paymentMethod || paymentMethod === 'Способ оплаты') continue;

                // Normalize payment method
                let pmKey = paymentMethod;
                if (paymentMethod !== 'Card' && paymentMethod !== 'SbpPay') {
                    pmKey = 'QR'; // Group all other methods as QR
                }

                // Колонка «Заказ из приложения»: у Лайта своя ставка комиссии,
                // поэтому такие заказы считаем отдельной строкой
                const appName = (row[12] || '').trim().toLowerCase();
                const isLight = appName.includes('лайт');

                const key = pmKey + '|' + (isLight ? 'light' : 'main');
                if (!ordersByPayment[key]) {
                    ordersByPayment[key] = { pmKey: pmKey, isLight: isLight, orders: 0, revenue: 0, returns: 0, commission: 0 };
                }

                ordersByPayment[key].orders += 1;
                ordersByPayment[key].revenue += parseNum(row[3]);
                ordersByPayment[key].returns += parseNum(row[7]);
                ordersByPayment[key].commission += parseNum(row[15]);
            }
        }

        // Finalize last venue
        finalizeVenue();

        // Extract month from data for the title
        let month = '';
        for (const row of rows) {
            if (row[0] && row[0].startsWith('20') && row[0].length >= 7) {
                month = row[0].substring(0, 7); // "2026-03"
                break;
            }
        }

        return { venues, lightTotals, month };
    }

    function formatNumber(n) {
        if (n === null || n === undefined) return '';
        if (n === 0) return '0.00';
        return n.toLocaleString('en-US', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        });
    }

    function renderTable(data) {
        const { venues, lightTotals, month } = data;

        if (month) {
            const [y, m] = month.split('-');
            const monthNames = ['', 'январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
                'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
            resultsTitle.textContent = `Результат — ${monthNames[parseInt(m)]} ${y}`;
        }

        renderLightSummary(lightTotals);

        resultBody.innerHTML = '';

        for (const v of venues) {
            const tr = document.createElement('tr');

            if (v.type === 'total') {
                tr.className = 'row-total';
            } else if (v.type === 'sub') {
                tr.className = 'row-sub';
            }
            if (v.isLight) {
                tr.className = (tr.className ? tr.className + ' ' : '') + 'row-light';
            }

            tr.innerHTML = `
                <td>${escapeHtml(v.name)}</td>
                <td>${escapeHtml(v.legal)}</td>
                <td>${escapeHtml(v.inn)}</td>
                <td class="num">${formatNumber(v.revenue)}</td>
                <td class="num">${formatNumber(v.returns)}</td>
                <td class="num">${formatNumber(v.afterReturns)}</td>
                <td class="num">${v.commission !== null ? formatNumber(v.commission) : ''}</td>
            `;

            resultBody.appendChild(tr);
        }
    }

    // Сводка «у кого есть Бартелло Лайт» и сколько он дал оборота/комиссии
    function renderLightSummary(lightTotals) {
        if (!lightSummary) return;

        if (!lightTotals || lightTotals.length === 0) {
            lightSummary.classList.add('hidden');
            lightSummary.innerHTML = '';
            return;
        }

        const orders = lightTotals.reduce((acc, t) => acc + t.orders, 0);
        const afterReturns = lightTotals.reduce((acc, t) => acc + t.afterReturns, 0);
        const commission = lightTotals.reduce((acc, t) => acc + t.commission, 0);
        const venuesCount = new Set(lightTotals.map((t) => t.venue)).size;

        const items = lightTotals
            .slice()
            .sort((a, b) => b.afterReturns - a.afterReturns)
            .map((t) => `<li><span class="light-summary__venue">${escapeHtml(t.venue)}</span>
                <span class="light-summary__meta">${escapeHtml(t.label)} · ${t.orders} зак. ·
                оборот ${formatNumber(t.afterReturns)} · комиссия ${formatNumber(t.commission)}</span></li>`)
            .join('');

        lightSummary.innerHTML = `
            <h3>Бартелло Лайт — ${venuesCount} завед., ${orders} зак.,
                оборот ${formatNumber(afterReturns)}, комиссия ${formatNumber(commission)}</h3>
            <ul>${items}</ul>`;
        lightSummary.classList.remove('hidden');
    }

    function escapeHtml(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    function downloadExcel() {
        if (!currentData) return;

        const { venues, lightTotals, month } = currentData;

        const wsData = [
            ['Название заведения', 'ЮРЛИЦО', 'ИНН', 'Оборот', 'Возвраты', 'Оборот после возвратов', 'Комиссия Бартелло']
        ];

        for (const v of venues) {
            wsData.push([
                v.name,
                v.legal,
                v.inn,
                v.revenue || '',
                v.returns || '',
                v.afterReturns || '',
                v.commission !== null ? (v.commission || '') : ''
            ]);
        }

        const wb = XLSX.utils.book_new();
        const ws = XLSX.utils.aoa_to_sheet(wsData);

        // Set column widths
        ws['!cols'] = [
            { wch: 50 }, // Name
            { wch: 40 }, // Legal
            { wch: 15 }, // INN
            { wch: 18 }, // Revenue
            { wch: 15 }, // Returns
            { wch: 22 }, // After returns
            { wch: 20 }, // Commission
        ];

        XLSX.utils.book_append_sheet(wb, ws, 'Оборот');

        // Отдельный лист по Бартелло Лайт — чтобы не искать строки глазами
        if (lightTotals && lightTotals.length > 0) {
            const lightData = [
                ['Название заведения', 'Способ оплаты', 'Заказов', 'Оборот', 'Оборот после возвратов', 'Комиссия Бартелло']
            ];
            for (const t of lightTotals) {
                lightData.push([t.venue, t.label, t.orders, t.revenue, t.afterReturns, t.commission]);
            }
            const wsLight = XLSX.utils.aoa_to_sheet(lightData);
            wsLight['!cols'] = [{ wch: 50 }, { wch: 14 }, { wch: 10 }, { wch: 18 }, { wch: 22 }, { wch: 20 }];
            XLSX.utils.book_append_sheet(wb, wsLight, 'Лайт');
        }

        const filename = month ? `Bartello_оборот_${month}.xlsx` : 'Bartello_оборот.xlsx';
        XLSX.writeFile(wb, filename);
    }

    function showError(msg) {
        errorDiv.textContent = msg;
        errorDiv.classList.remove('hidden');
    }
});
