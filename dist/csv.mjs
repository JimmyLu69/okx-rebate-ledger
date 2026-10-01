// Formula detection skips Unicode whitespace and control characters because
// spreadsheet programs may remove them before interpreting = + - @ formulas.
export function csvCell(value){
 let text=String(value??'');
 const first=text.replace(/^[\s\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060\ufeff]+/u,'');
 if(/^[=+@-]/.test(first)||/^[\t\r\n]/.test(text))text="'"+text;
 return '"'+text.replaceAll('"','""')+'"';
}
export function encodeCsv(rows){return '\uFEFF'+rows.map(row=>row.map(csvCell).join(',')).join('\r\n')}
