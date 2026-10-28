import {describe,it,expect} from 'vitest';
import {simpleFileTask} from '../src/simple-file-task.js';
describe('simple literal file task',()=>{
 it('recognizes the explicit Turkish write-and-verify scenario',()=>{
  expect(simpleFileTask('SOHBETTEN GÖREVE TESTİ: /tmp/test.txt dosyasına tam olarak “Hızlı sohbet ve güvenli görev geçişi.” yaz. Gerçek tek seferlik onay kartını kullan. Sonra dosyayı geri okuyarak bu metnin aynen kaydedildiğini doğrula. Tamamlanan adımları güncelle ve kısa sonuç ver. İnternet veya başka dosya kullanma.')).toEqual({path:'/tmp/test.txt',content:'Hızlı sohbet ve güvenli görev geçişi.'});
 });
 it('accepts a minimal literal with optional verification',()=>{expect(simpleFileTask('/tmp/a.txt dosyasına tam olarak "test" yaz ve doğrula.')).toEqual({path:'/tmp/a.txt',content:'test'});});
 it.each([
  '/tmp/a.txt dosyasına kaynak.csv verilerinden rapor yaz.',
  '/tmp/a.txt dosyasına tam olarak “test” yaz. Sonra e-posta gönder.',
  '/tmp/a.txt dosyasına tam olarak “test” yaz. /tmp/b.txt dosyasını da oluştur.',
  '/tmp/a.txt dosyasına tam olarak “test” yaz ama mevcut içeriği koru.',
  '/tmp/a.txt dosyasına tam olarak “test” yaz. Önce mevcut dosyayı oku.',
  '/tmp/a.txt dosyasına tam olarak “test” yaz. Sonra dosyayı sil.',
  'Projects/a.txt dosyasına tam olarak “test” yaz.',
  '/tmp/a.pdf dosyasına tam olarak “test” yaz.',
 ])('leaves other tasks on the general path (%s)',goal=>expect(simpleFileTask(goal)).toBeNull());
});
