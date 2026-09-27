# Online-Mind2Web: 20 görev

Resmî veri kümesi [OSU NLP Group](https://huggingface.co/datasets/osunlp/Online-Mind2Web)
tarafından erişim koşullu yayımlanıyor. Koşullar kabul edilip
`Online_Mind2Web.json` indirildikten sonra `select.mjs` 20 farklı siteden
tekrarlanabilir bir aday listesi çıkarır:

```bash
node evals/online-mind2web/select.mjs /path/to/Online_Mind2Web.json > /tmp/ocak-om2w-candidates.json
```

Çıktı **değerlendirme sonucu değildir**. Görevler, site erişilebilirliği ve
hesap/ödeme/CAPTCHA gereksinimleri açısından elle incelenmeli. Ardından
görev kimlikleri dondurulup Tenami tarayıcı ajanıyla üçer kez çalıştırılmalı.
Her koşuda başarı (0/1/çalıştırılamadı), adım sayısı, adım başına prompt ve
çıktı token sayısı, toplam süre ve başarısızlık nedeni kaydedilmeli. Herhangi
bir adımda 16.000 token üstü kullanımı regresyondur. Başarı etiketi yalnız
görevin son durumunu inceleyen bağımsız değerlendirmeyle verilir; modelin
“başardım” demesi kanıt sayılmaz.

## Kaydedilmiş koşunun token ölçümü

Tenami oturumundaki `usage` olayları her model adımının prompt ve çıktı token
sayısını taşır. Oturum dosyasındaki sohbet, araç argümanları ve sayfa içeriği
çıktıya kopyalanmadan ölçülebilir:

```bash
node evals/online-mind2web/score.mjs /path/to/session.json > /tmp/tenami-metrics.json
node --test evals/online-mind2web/score.test.mjs
```

`tokenRegression: true`, bir adımda toplam 16.000 token aşıldı demektir.
`null`, sağlayıcı kullanım verisini vermediği için eşik doğrulanamadı demektir.
`success` bilerek `null` kalır; görevin sonucu bağımsız olarak incelenmelidir.
Bu araç veri kümesini indirmez ve 20 görevi çalıştırmaz.
