import {it,expect} from 'vitest';
import {numericFacts,wrongAverageMargin} from '../src/numeric-facts.js';
const source='Ay,Gelir_TL,Gider_TL\nOcak,12000,8000\nSubat,15500,9500\nMart,18000,11000\nNisan,16000,10500\nMayis,21000,13000\nHaziran,24000,14500\n';
it('computes source numbers independently of the author and distinguishes weighted from arithmetic margin',()=>{
 const facts=numericFacts(source)[0]!;
 expect(facts.columns.Gelir_TL?.sum).toBe(106500);expect(facts.columns.Gelir_TL?.change).toBe(12000);
 expect(facts.differences[0]?.sum).toBe(40000);expect(facts.differences[0]?.ratioOfSumsPercent).toBeCloseTo(37.5587,3);
 expect(facts.differences[0]?.meanRowRatioPercent).toBeCloseTo(37.1642,3);
 expect(wrongAverageMargin('Ortalama kâr marjı: %37,56.',source)).toMatch(/37.16/);
 expect(wrongAverageMargin('Toplam kâr marjı: %37,56.',source)).toBeNull();
});
