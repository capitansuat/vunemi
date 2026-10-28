/** CSV shape validation. Quoted decimal commas and embedded newlines are legal. */
export function csvIssue(text: string, expectedRows?: number): string | null {
 const rows: number[]=[];let columns=1,quoted=false,closed=false,atStart=true,content=false;
 for(let i=0;i<text.length;i++){
  const c=text[i]!;
  if(quoted){if(c==='"'){if(text[i+1]==='"')i++;else {quoted=false;closed=true;}}continue;}
  if(c==='"'){if(!atStart)return 'Unexpected quote in CSV field.';quoted=true;content=true;continue;}
  if(c===','){columns++;atStart=true;closed=false;content=true;continue;}
  if(c==='\n'||c==='\r'){if(c==='\r'&&text[i+1]==='\n')i++;if(content)rows.push(columns);columns=1;atStart=true;closed=false;content=false;continue;}
  if(closed)return 'Unexpected text after closing CSV quote.';
  atStart=false;content=true;
 }
 if(quoted)return 'Unclosed CSV quote.';
 if(content)rows.push(columns);
 if(expectedRows!==undefined && rows.length-1!==expectedRows)return `CSV has ${Math.max(0,rows.length-1)} data rows; expected ${expectedRows}.`;
 const width=rows[0];const bad=rows.findIndex(n=>n!==width);
 return bad<0?null:`CSV row ${bad+1} has ${rows[bad]} fields; header has ${width}. Use decimal dots, or quote fields containing commas.`;
}
