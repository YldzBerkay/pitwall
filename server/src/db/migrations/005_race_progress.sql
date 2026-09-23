-- 005_race_progress.sql — yarışın NEREYE KADAR KOŞTUĞUNUN saklanan gerçeği.
-- Spec: docs/superpowers/specs/2026-09-23-faz3a2-lobi-yaris-kosucusu.md §10
--
-- Bu göç yarış DURUMUNU saklamaya başlamaz ve 004'ün "durum değil tarif"
-- kuralını da bozmaz. Burada KASITLA yoktur: araçların yeri, lastik ömrü,
-- olay günlüğü, puanlar — hepsi tariften türemeye devam eder ve tek bir tanesi
-- bile bu tabloya sızmamalıdır. Eklenen tek şey, tarifin hangi noktaya kadar
-- TÜKETİLDİĞİdir; bu bir sonuç değil, bir imleçtir.
--
-- NEDEN GEREKLİ — SAAT YETMEZ:
-- 004 ile birlikte "kaçıncı turdayız" sorusunun cevabı saatti:
-- `tur = (now - started_at) / RACE_TICK_MS`. Pit uç noktası da tik döngüsü de
-- aynı formülü AYRI AYRI hesaplıyordu ve aralarında hiçbir kilit yoktu. Tik
-- günlüğü okuduktan sonra, N. turu simüle etmeden önce yazılan bir karar uç
-- noktanın kapısından geçer ("N henüz koşmadı" — saate göre doğru), canlı
-- yarışça GÖRÜLMEZ (günlük zaten okunmuştu) ve sonraki her yeniden oynatmaca
-- UYGULANIR. İki farklı yarış; bu fazın var olma sebebi tam da budur.
-- Pencere tik başına ~1 ms'tir, yani nadirdir ama yüzlerce lobi × yetmiş turda
-- kaçınılmazdır ve sessizce bozar.
--
-- Saat bir TEMENNİdir: iki süreç arasında kilitlenemez, geriye alınamaz ve
-- "koştu mu" sorusunu ancak tahmin eder. `last_lap` ise bir OLGUdur: turu
-- koşan süreç onu simülasyondan ÖNCE damgalar, karar yazması da aynı satırı
-- `for update` ile kilitler. Böylece "karar yazıldıysa turu mutlaka görür"
-- sözü umuttan çıkıp veritabanı kilidine dayanır.
--
-- NEDEN AYRI BİR TABLO DEĞİL: imleç koşunun kendisine aittir ve koşuyla
-- birlikte doğup ölür; ayrı bir tablo, kararın kapısını (`race_decisions`
-- yazması) ile imleci farklı satırlara dağıtır ve tek bir `for update` ile
-- kilitlenemez hale getirirdi.

-- "Şimdiye kadar simüle edilmiş EN YÜKSEK tur." 0 = ışıklar söndü, henüz tek
-- tur koşulmadı. Yalnızca artar (`raceRepo.advanceLastLap` `where last_lap < $`
-- ile yazar): geri düşmesi, koşulmuş bir tura karar yazma kapısını yeniden
-- AÇARDI — tam da kapatmak için var olan kapıyı.
--
-- `default 0` var olan koşular için de doğrudur: 005 öncesi yazılmış bir yarış
-- için "hiçbir tur koşulmadı" demek en güvenli başlangıçtır. Yanlış yönde
-- yanılır — kapı gereğinden GEVŞEK değil, gereğinden SIKI olmaz; koşucu ilk
-- tikinde saatin dediği tura damgayı basıp gerçeğe oturur.
alter table race_runs add column if not exists last_lap integer not null default 0;

-- `if not exists` kısıtlarda yok; göç yeniden çalıştırılabilir kalsın diye
-- önce düşürüyoruz (004'ün `lobbies_due_idx`i aynı nedenle böyle yapıyor).
alter table race_runs drop constraint if exists race_runs_last_lap_check;
alter table race_runs add constraint race_runs_last_lap_check check (last_lap >= 0);

-- `race_runs_immutable` (004) yalnızca `seed` ve `snapshot` değişimini
-- reddeder; `finished_at` gibi `last_lap` da GÜNCELLENEBİLİR kalır ve kalmak
-- ZORUNDADIR — tetikleyici bunu engelleseydi tik döngüsü ilk turda patlardı.
-- Bu, yorumda bırakılan bir temenni değil: `server/test/race-runner.test.ts`
-- tetikleyicinin damgayı geçirdiğini doğrudan sınar.
