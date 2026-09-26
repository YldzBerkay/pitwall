-- 011_espionage_client_exposure.sql — casusluğu istemciye açan üç alan.
--
-- Faz 3b-1 kapanışı, ikinci parça. Sunucu casusluğu tam olarak çözüyordu ama
-- üç sonucu hiçbir yere yazmıyordu: (1) bir görevin claim ANINDA çözülen
-- sonucu (`outcome`/`fine`) yalnızca `applySpyEffect`'in dönüş değerindeydi
-- ve `actions.ts` onu atıyordu; (2) bir rakibin insan koltuğuna karşı
-- yerleşim (settlement) anında denediği casusluk hiçbir yere kaydedilmiyordu
-- — oyuncu hiç öğrenemiyordu; (3) garaj gizleme zaten `garage_hides`'ta
-- duruyordu ama `SlotState` onu hiç okumuyordu. Bu göç yalnızca (2)'nin
-- deposunu açar — (1) ve (3) zaten var olan depolardan (claimJob'ın dönüşü,
-- garage_hides) okunacağı için yeni sütun istemiyor.
--
-- BURADA KASITLI OLARAK YOK OLAN: rakip casusluğun GEÇMİŞİ. Yalnızca BU
-- yarışın döküm satırına ait tek bir deneme saklanır — `race_settlement_
-- payouts` zaten "bir takımın bir yarıştan aldığı" için bir satır, aynı
-- disiplin rakip casusluk denemesi için de geçerli: bir sonraki yarış kendi
-- satırını yazar, öncekini asla okumaz.
--
-- NEDEN AYRI TABLO DEĞİL: rakip casusluk denemesi zaten "bu yarışın
-- dökümü"nün bir parçası — `race_settlement_payouts`'un kendisi tam da bu
-- kavram için var. Ayrı bir tablo, `010_garage_hide.sql`'in "sürekli bir
-- savunma durumu" ile "bekleyen bir görev etkisi"ni ayırdığı gerekçeyle
-- karışırdı: burada ikisi de aynı kavram (bir yarışın dökümü), o yüzden aynı
-- satıra iki sütun olarak eklenir.
--
-- NEDEN İKİSİ BİRDEN NULL YA DA İKİSİ BİRDEN DOLU: `runRivalEspionage`
-- (economy/settle.ts) yalnızca insan koltuklarını dener ve HER turda
-- denemez (bkz. `rivalAttempt`, shared/src/espionage.ts — tabloda ilk 4'te
-- olmayan ya da zar tutmayan bir koltuk hiç denenmez). Deneme hiç
-- olmadıysa iki sütun da NULL — "bu yarış rakip casusluğa hiç konu
-- olmadı" ile "denendi ama başarısız/engellendi" (rival_spy_success = false)
-- arasındaki fark, tıpkı 010'daki garage_hides satırının hiç olmaması ile
-- until_round'un geçmiş bir tur olması arasındaki fark gibi, doğal olarak
-- korunur.
alter table race_settlement_payouts
  add column if not exists rival_spy_team    text,
  add column if not exists rival_spy_success boolean;

alter table race_settlement_payouts
  add constraint race_settlement_payouts_rival_spy_pair_check
  check ((rival_spy_team is null) = (rival_spy_success is null));
