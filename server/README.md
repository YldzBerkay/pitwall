# Pit Wall — Lig Sunucusu

Aynı yarış motorunu (`mobile/src/data`) sabit bir saatte koşturur ve her turu
WebSocket ile yayınlar. Sunucu otoritedir; istemci sadece çizer ve pit
çağrısı gönderir.

## Çalıştırma

```bash
cd server && npm install
npm run dev          # ilk yarış 20 sn sonra, check-in 15 sn önce açılır (geliştirme)
npm start            # varsayılan: ilk yarış 1 saat sonra, check-in 5 dk, günde bir yarış
```

Ortam değişkenleri: `PORT` (8787), `TICK_MS` (2500), `CHECKIN_SECONDS` (300),
`INTERVAL_SECONDS` (86400), `RACE_IN_SECONDS` (3600).

## Uç noktalar

| Yöntem | Yol | Gövde | Açıklama |
|---|---|---|---|
| GET | `/state` | — | Faz, ışık saati, check-in açılışı, pist, tablo, takımlar |
| POST | `/join` | `teamKey, managerId` | Takımı üstlen; dolu koltuk `taken` |
| POST | `/weekend` | `teamKey, managerId, setup?, tactics?, risk?, reliability?` | Hafta sonu seçimleri (yarış canlıyken reddedilir) |
| POST | `/checkin` | `teamKey, managerId` | Sadece `checkin` fazında; yoksa `closed` |
| POST | `/pit` | `teamKey, managerId, driverIdx, compound\|null` | Sonraki tur için pit çağrısı; check-in yapmamış takım için reddedilir |
| WS | `/live` | — | `{type:'phase'}`, `{type:'lap', race}`, `{type:'result', result}` |

Faz akışı: `open → checkin (T−5dk) → live (T) → result → open (sonraki tur)`.
Check-in yapmayan takımı motor `managed: 'assistant'` ile koşturur; kimsenin
üstlenmediği takımlar AI'dır.

## Dağıtım

`railway.json` hazır: `railway up` ile deploy edilir; `PORT` Railway
tarafından verilir. İstemcide Race Week → Online Lig kartına sunucu adresini
yaz.

Kalıcılık yok: süreç yeniden başlarsa lig sıfırlanır. Sıradaki iş Postgres.
