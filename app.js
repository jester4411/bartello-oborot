document.addEventListener('DOMContentLoaded', () => {
    const dropZone = document.getElementById('dropZone');
    const fileInput = document.getElementById('fileInput');
    const loading = document.getElementById('loading');
    const errorDiv = document.getElementById('error');
    const results = document.getElementById('results');
    const resultBody = document.getElementById('resultBody');
    const resultsTitle = document.getElementById('resultsTitle');
    const downloadBtn = document.getElementById('downloadBtn');

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
        let currentVenue = null;
        let ordersByPayment = {};

        function finalizeVenue() {
            if (!currentVenue) return;

            const methods = Object.keys(ordersByPayment);
            const hasMultipleMethods = methods.length > 1;

            if (hasMultipleMethods) {
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

                // Sub-rows for each payment method
                const methodOrder = ['Card', 'SbpPay'];
                // Add any other methods (QR etc)
                for (const m of methods) {
                    if (!methodOrder.includes(m)) methodOrder.push(m);
                }

                for (const method of methodOrder) {
                    if (!ordersByPayment[method]) continue;
                    const data = ordersByPayment[method];
                    const label = method === 'Card' ? 'К' :
                                  method === 'SbpPay' ? 'SBP' : 'QR';
                    venues.push({
                        type: 'sub',
                        name: currentVenue.name + ' ' + label,
                        legal: '',
                        inn: '',
                        revenue: data.revenue,
                        returns: data.returns,
                        afterReturns: data.revenue - data.returns,
                        commission: data.commission
                    });
                }
            } else {
                // Single payment method — one row
                venues.push({
                    type: 'single',
                    name: currentVenue.name,
                    legal: currentVenue.legal,
                    inn: currentVenue.inn,
                    revenue: currentVenue.revenue,
                    returns: currentVenue.returns,
                    afterReturns: currentVenue.afterReturns,
                    commission: currentVenue.commission
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

                if (!ordersByPayment[pmKey]) {
                    ordersByPayment[pmKey] = { revenue: 0, returns: 0, commission: 0 };
                }

                ordersByPayment[pmKey].revenue += parseNum(row[3]);
                ordersByPayment[pmKey].returns += parseNum(row[7]);
                ordersByPayment[pmKey].commission += parseNum(row[15]);
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

        return { venues, month };
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
        const { venues, month } = data;

        if (month) {
            const [y, m] = month.split('-');
            const monthNames = ['', 'январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
                'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
            resultsTitle.textContent = `Результат — ${monthNames[parseInt(m)]} ${y}`;
        }

        resultBody.innerHTML = '';

        for (const v of venues) {
            const tr = document.createElement('tr');

            if (v.type === 'total') {
                tr.className = 'row-total';
            } else if (v.type === 'sub') {
                tr.className = 'row-sub';
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

    function escapeHtml(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    function downloadExcel() {
        if (!currentData) return;

        const { venues, month } = currentData;

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

        const filename = month ? `Bartello_оборот_${month}.xlsx` : 'Bartello_оборот.xlsx';
        XLSX.writeFile(wb, filename);
    }

    function showError(msg) {
        errorDiv.textContent = msg;
        errorDiv.classList.remove('hidden');
    }
});
