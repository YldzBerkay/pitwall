-- 017_driver_seat_stopgap.sql — bir yarış koltuğunun sözleşmesi bittiğinde
-- gerçekten AYRILMASI, ve koltuğu boş bırakmak yerine bir yedek (stopgap)
-- sürücünün doldurması.
--
-- Spec: görev metni'nin takip kararı — "when a human race-seat contract
-- expires, the driver leaves and a stopgap driver takes the seat until the
-- player signs someone", 016_driver_contracts.sql'in sabitlediği kenetin
-- (`seasonsLeft = 1`'de sonsuza dek kilitlenme) yerine.
--
-- BU GÖÇTE KASITLI OLARAK YOK OLAN:
--   * AI transfer penceresi hâlâ inşa edilmiyor — bir AI koltuğu hiçbir
--     zaman stopgap'e düşmez, sözleşmesi her kışın sonunda otomatik yenilenir
--     (`drivers/ageing.ts` `tickContract`, değişmedi).
--
-- ── `is_stopgap` ──────────────────────────────────────────────────────────
-- Bir stopgap İMZALANMIŞ bir sürücü DEĞİLDİR: sözleşmesi yok, satılamaz,
-- yenilenemez. Bunu `seasons_left = 0`'a bakarak ÇIKARSAMAK yerine (0,
-- "sözleşmesi bu kış bitti ama henüz tiklenmedi" ile karışabilirdi) açık bir
-- bayrakla saklıyoruz — 014/016'nın "numaralandırılmış bir sütun bir kez
-- kontrolsüz bırakılıp sessizce yanlış kabul edilmiş ve bir yarışı kalıcı
-- olarak zehirlemişti" dersiyle aynı gerekçe: belirsiz bir sayısal durumdan
-- çıkarsamak yerine kendi sütununu taşı.
--
-- Var olan sözleşme kontrolü gevşetiliyor: bir stopgap TAM SIFIR
-- `seasons_left`/`wage` taşır (gerçek bir sürücünün asla sıfıra inmeyen
-- sözleşmesinden ayrışsın diye), her ŞEY BAŞKASI pozitif kalmaya devam eder.
alter table lobby_drivers add column if not exists is_stopgap boolean not null default false;

alter table lobby_drivers drop constraint if exists lobby_drivers_seasons_left_check;
alter table lobby_drivers add constraint lobby_drivers_seasons_left_check
  check ((is_stopgap and seasons_left = 0) or (not is_stopgap and seasons_left > 0));

alter table lobby_drivers add constraint lobby_drivers_wage_stopgap_check
  check (not is_stopgap or wage = 0);

-- ── `market_id` ───────────────────────────────────────────────────────────
-- Bir RACE SEAT satırının kendi kimliği hep `takımAnahtarı:koltukNo`dur
-- (014'ün "Kimlik" notu) — pazardan imzalanan sürücü koltuğa girdiğinde bile
-- bu değişmez. Ama bir koltuğun sözleşmesi bittiğinde ONU imzalayan pazar
-- kimliğinin serbest bırakılması (`lobby_driver_signings`den silinmesi)
-- gerekiyor, ve satırın kendi kimliği bunu söylemiyor. `market_id` bu
-- eksik bağı taşır: yalnızca bir koltuk pazardan biri ile dolduğunda dolar,
-- takım varsayılanı hiç değişmemiş bir koltukta ya da bir stopgap'te NULL'dur
-- (ikisi de hiçbir pazar kimliğini "tutmuyor").
alter table lobby_drivers add column if not exists market_id text;
