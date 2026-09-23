/**
 * Lobi başına canlı yayın odaları.
 *
 * NEDEN ODA: bugünkü `/live` TEK bir ligin her turunu BAĞLI HERKESE yolluyor.
 * Her lobinin kendi yarışı olduğu anda bu iki yönden birden yanlış: oyuncu
 * başka lobilerin turlarını alır (sızıntı) ve hangi yarışın kendi yarışı
 * olduğunu ayırt edemez (belirsizlik). Bu yüzden yayın `lobbyId`ye göre
 * bölünür ve her mesaj hangi lobiye ait olduğunu KENDİ ÜZERİNDE taşır.
 *
 * ── ABONELİK KOLTUKLA KAPILI ─────────────────────────────────────────────
 * Yalnızca o lobide KOLTUĞU olan bir kullanıcı abone olabilir. İzleyici
 * (spectator) modu bu fazın kapsamında DEĞİL ve kapıyı şimdi dar tutmak
 * bilinçli: sonradan gevşetmek (herkese açmak) uyumlu bir değişikliktir,
 * sonradan daraltmak ise çalışan istemcileri kırar. Dahası yayın, henüz
 * herkese gösterilmesi kararlaştırılmamış tarif verisini (kim asistan sürüyor,
 * lastik planı) taşıyor; onu açmak geri alınamaz.
 *
 * ── SOKET KİMLİK DOĞRULAMASI: TOKEN GÖVDEDE, URL'DE DEĞİL ────────────────
 * HTTP tarafında oturum `Authorization: Bearer` başlığından okunuyor
 * (`http/router.ts`). Tarayıcının `WebSocket` API'si el sıkışmaya ÖZEL BAŞLIK
 * EKLEYEMEZ, yani o desen sokete OLDUĞU GİBİ uzanmıyor. Token'ı sorgu dizesine
 * koymak en kolay yol olurdu ama oturum anahtarını URL'ye yazmak onu erişim
 * kayıtlarına, proxy günlüklerine ve `Referer`a sızdırır. Bu yüzden en küçük
 * dürüst seçenek: soket açılır, token UYGULAMA MESAJINDA gelir
 * (`{type:'subscribe', lobbyId, token}`) ve HTTP ile birebir aynı
 * `verifySession` ile doğrulanır. Yeni bir şema, yeni bir sır, yeni bir ömür
 * YOK — aynı JWT, farklı taşıyıcı.
 *
 * ── NE YAYINLANIR: SAAT DEĞİL, SAKLANAN `last_lap` ───────────────────────
 * Turu duvar saatinden türeten bir istemciye, sunucunun HENÜZ DAMGALAMADIĞI
 * bir tur gösterilebilir; oyuncu o zaman kapanmış bir tur için pit çağrısının
 * hâlâ mümkün olduğunu sanır (`checkin.ts` ve `raceRepo.ts` docblock'ları:
 * kapının otoritesi `race_runs.last_lap`). Yayın bunu TEKRAR ETMEMELİ. Bu
 * yüzden:
 *  · geç gelen abonenin gördüğü görüntü `uptoLap = run.lastLap` ile oynatılır,
 *    saatle DEĞİL — damga "bu tur simüle edilecek/edildi" diyen tek olgudur;
 *  · canlı turlar koşucunun verdiği `RaceState.lap` ile gider, bu modül hiçbir
 *    yerde `Date.now()` okumaz. Zaten `now` yalnızca route'ta örneklenir ve
 *    istemciden ASLA alınmaz (server/README.md §"now sadece route'ta").
 *
 * ── DURUM MUTASYONU YOK ──────────────────────────────────────────────────
 * `startRace` `entries`/`standings`i REFERANSLA saklar
 * (`state.entries === snapshot.entries`, bkz. `replay.ts`). Serileştirici
 * onlara dokunursa tarif bozulur ve o yarışı SONRADAN oynatan herkes başka bir
 * yarış görür. Aşağıdaki `serialise` yalnızca OKUR: alanları yeni bir sarmal
 * nesneye takar, hiçbir diziyi sıralamaz/kesmez.
 * Bir gün sağlama (checksum) eklenirse `cars`/`events` üzerinden alınmalı,
 * serileştirilmiş tarif üzerinden DEĞİL: Postgres `jsonb` anahtarlarını
 * yeniden sıralar, yani sunucunun hesabı ile tarifi çekmiş bir istemcininki
 * hiçbir sebep yokken ayrışırdı.
 */
import type { WebSocket } from 'ws';
import type { RaceState } from '@pitwall/shared/raceEngine';
import { verifySession } from '../auth/jwt.ts';
import { query } from '../db/pool.ts';
import { loadDecisions, loadRun } from './raceRepo.ts';
import { replayRace } from './replay.ts';

/**
 * Yeni odaların yolu.
 *
 * `/live` ESKİ tek ligli yayında ve o uç bu görevde KALDIRILMIYOR; aynı yolu
 * paylaşmak iki yayını aynı soketlere karıştırırdı — düzeltmeye çalıştığımız
 * hatanın ta kendisi. `/race/checkin` ve `/race/pit` ile aynı aile adı:
 * `/race/live`.
 */
export const LIVE_PATH = '/race/live';

type Outgoing =
  | { type: 'state'; lobbyId: string; race: SerialisedRace | null }
  | { type: 'lap'; lobbyId: string; race: SerialisedRace }
  | { type: 'unsubscribed'; lobbyId: string }
  | { type: 'error'; error: string };

interface SerialisedRace {
  lap: number;
  laps: number;
  finished: boolean;
  wet: boolean;
  trackKey: string;
  round: number;
  session: 'race' | 'sprint';
  cars: RaceState['cars'];
  events: RaceState['events'];
  control: RaceState['control'];
  fastestLap: RaceState['fastestLap'];
  weather: RaceState['weather'];
  neutralised: RaceState['neutralised'];
}

/**
 * Durumu KOPYALAMADAN, DEĞİŞTİRMEDEN ağ biçimine çevirir.
 *
 * `cars`/`events` referansla takılıyor; `JSON.stringify` onları yalnızca okur.
 * `entries`/`standings`/`rosters` KASITLA dışarıda: onlar tarifin paylaşılan
 * nesneleri ve her turda yeniden yollanacak veri değiller — geç gelen abonenin
 * ilk `state` mesajı yarışın o anki resmini zaten taşıyor.
 *
 * İLKE: yayın istemcinin yarışı ÇİZMESİ için ne gerekiyorsa onu taşır, yarışı
 * YENİDEN HESAPLAMASI için gerekeni değil. `weather`/`neutralised` bu yüzden
 * BURADA: ikisi de ekranda görünen bir gerçeği anlatır (hava durumu paneli,
 * bayrak göstergesi), tarif değildir — hesaplama girdisi değil, hesaplamanın
 * SONUCUdur. `standings`/`entries`/`rosters` ise tam tersi: onları yollamak
 * istemcinin kendi settlement'ını ve kendi simülasyonunu sürdürmesine izin
 * verirdi — bu fazın silmeye çalıştığı ikinci gerçekliğin ta kendisi.
 * Settlement zaten sunucunun işi ve zaten çalışıyor (`economy/settle.ts`).
 */
function serialise(state: RaceState): SerialisedRace {
  return {
    lap: state.lap,
    laps: state.laps,
    finished: state.finished,
    wet: state.wet,
    trackKey: state.trackKey,
    round: state.round,
    session: state.session,
    cars: state.cars,
    events: state.events,
    control: state.control,
    fastestLap: state.fastestLap,
    weather: state.weather,
    neutralised: state.neutralised,
  };
}

function send(socket: WebSocket, message: Outgoing): void {
  // 1 === OPEN. Kapanmakta olan bir sokete yazmak `ws`te fırlatır; oda
  // temizliği `close` olayına bağlı olduğu için arada bir tik olabilir.
  if (socket.readyState !== 1) return;
  socket.send(JSON.stringify(message));
}

/** Oyuncunun bu lobide koltuğu var mı — `checkin.ts`teki `findOwnTeamKey` ile aynı kaynak. */
async function hasSeat(lobbyId: string, userId: string): Promise<boolean> {
  const res = await query(
    'select 1 from lobby_seats where lobby_id = $1 and user_id = $2',
    [lobbyId, userId],
  );
  return (res.rowCount ?? 0) > 0;
}

interface LobbyRow {
  season_no: number;
  round_no: number;
}

/**
 * Lobinin O ANKİ yarışı — geç gelen abone için.
 *
 * Yeniden oynatma tam da bunun için var (ve çökme sonrası devam için):
 * istemciyi bir sonraki tura kadar boş ekranda bekletmek yerine tarifi
 * `last_lap`e kadar oynatıp resmi hemen veriyoruz. `null`: lobi yarışmıyor ya
 * da tarif henüz yazılmadı (ışıkları söndüren tik daha koşmadı).
 */
async function currentRace(lobbyId: string): Promise<SerialisedRace | null> {
  const lobby = await query<LobbyRow>(
    `select season_no, round_no from lobbies where id = $1 and phase = 'live'`,
    [lobbyId],
  );
  const row = lobby.rows[0];
  if (!row) return null;

  const run = await loadRun(lobbyId, row.season_no, row.round_no);
  if (!run) return null;

  const decisions = await loadDecisions(lobbyId, row.season_no, row.round_no);
  return serialise(replayRace({
    seed: run.seed,
    round: row.round_no,
    snapshot: run.snapshot,
    decisions,
    // OTORİTE SAKLANAN SAYAÇ. Saatten türetilen bir tur, sunucunun henüz
    // damgalamadığı bir turu gösterebilir; oyuncu o tur için pit çağrısının
    // hâlâ açık olduğunu sanır — oysa kapı `last_lap`e bakıyor. Damganın
    // ötesini yayınlamamak bu yanılgıyı yapısal olarak imkânsız kılar.
    uptoLap: run.lastLap,
  }));
}

export interface LiveHub {
  /** Yeni bir soketi dinlemeye başla (abonelik mesajlarını bekler). */
  attach(socket: WebSocket): void;
  /** Bir lobinin turunu YALNIZCA o lobinin odasına yolla. */
  publish(lobbyId: string, state: RaceState): void;
  roomSize(lobbyId: string): number;
  hasRoom(lobbyId: string): boolean;
  /** Açık oda sayısı — sızıntı testinin baktığı sayaç. */
  roomCount(): number;
}

class Hub implements LiveHub {
  /** lobbyId → o lobiyi izleyen soketler. Boşalan oda SİLİNİR. */
  private readonly rooms = new Map<string, Set<WebSocket>>();
  /** Soket → abone olduğu lobiler. Kapanışta odaları tek geçişte boşaltmak için. */
  private readonly membership = new Map<WebSocket, Set<string>>();

  attach(socket: WebSocket): void {
    socket.on('message', (raw) => {
      // Hata yutulmuyor, istemciye dönüyor: sessizce dinleyen ama hiçbir şey
      // almayan bir soket, hata ayıklanması en zor durumdur.
      void this.onMessage(socket, raw.toString()).catch(() => {
        send(socket, { type: 'error', error: 'internal_error' });
      });
    });
    // SIZINTI KAPISI: oda üyeliği soketin ömrüne bağlı. `close` hem normal
    // kapanışta hem de `error` sonrasında gelir (ws sözleşmesi), yani tek
    // dinleyici yeterli.
    socket.on('close', () => this.forget(socket));
  }

  private async onMessage(socket: WebSocket, raw: string): Promise<void> {
    let msg: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('shape');
      msg = parsed as Record<string, unknown>;
    } catch {
      return send(socket, { type: 'error', error: 'invalid_request' });
    }

    const lobbyId = typeof msg['lobbyId'] === 'string' ? msg['lobbyId'] : '';
    if (msg['type'] === 'unsubscribe') {
      if (!lobbyId) return send(socket, { type: 'error', error: 'invalid_request' });
      this.leave(socket, lobbyId);
      return send(socket, { type: 'unsubscribed', lobbyId });
    }
    if (msg['type'] !== 'subscribe') return send(socket, { type: 'error', error: 'invalid_request' });
    if (!lobbyId) return send(socket, { type: 'error', error: 'invalid_request' });

    const token = typeof msg['token'] === 'string' ? msg['token'] : '';
    const userId = await verifySession(token);
    if (!userId) return send(socket, { type: 'error', error: 'unauthorized' });

    // KOLTUK KAPISI. `checkin.ts` ile aynı sıra: lobide yeri olmayan biri
    // yarışın var olup olmadığını bile öğrenmemeli, bu yüzden görüntü
    // OKUNMADAN önce reddediliyor.
    if (!(await hasSeat(lobbyId, userId))) return send(socket, { type: 'error', error: 'forbidden' });

    // Yukarıdaki iki `await` sırasında soket kapanmış olabilir; kapanmışsa
    // odaya eklemek tam da kaçındığımız birikmeyi yaratırdı.
    if (socket.readyState !== 1) return;

    this.join(socket, lobbyId);
    // Önce GÖRÜNTÜ, sonra turlar. Sıra önemli: odaya katılım bu `await`ten
    // ÖNCE yapıldı ki aradaki bir tur kaybolmasın; istemci aynı turu iki kez
    // görebilir (görüntü + yayın) ama HİÇ görmemesi mümkün değil. Turlar
    // idempotent bir resim taşıdığı için tekrar zararsız, boşluk değil.
    send(socket, { type: 'state', lobbyId, race: await currentRace(lobbyId) });
  }

  private join(socket: WebSocket, lobbyId: string): void {
    let room = this.rooms.get(lobbyId);
    if (!room) { room = new Set(); this.rooms.set(lobbyId, room); }
    room.add(socket);
    let mine = this.membership.get(socket);
    if (!mine) { mine = new Set(); this.membership.set(socket, mine); }
    mine.add(lobbyId);
  }

  private leave(socket: WebSocket, lobbyId: string): void {
    const room = this.rooms.get(lobbyId);
    if (room) {
      room.delete(socket);
      // Boş oda SAKLANMAZ: yüz binlerce kapanmış lobi için boş `Set` tutmak
      // sessizce büyüyen bir sızıntıdır.
      if (room.size === 0) this.rooms.delete(lobbyId);
    }
    const mine = this.membership.get(socket);
    if (mine) {
      mine.delete(lobbyId);
      if (mine.size === 0) this.membership.delete(socket);
    }
  }

  private forget(socket: WebSocket): void {
    const mine = this.membership.get(socket);
    if (!mine) return;
    for (const lobbyId of [...mine]) this.leave(socket, lobbyId);
    this.membership.delete(socket);
  }

  publish(lobbyId: string, state: RaceState): void {
    const room = this.rooms.get(lobbyId);
    if (!room || room.size === 0) return;
    // Tek serileştirme, tek gönderim listesi: mesaj `lobbyId` taşıyor, yani
    // istemci hangi yarışı izlediğini mesajın kendisinden bilir.
    const payload = JSON.stringify({ type: 'lap', lobbyId, race: serialise(state) });
    for (const socket of room) {
      if (socket.readyState === 1) socket.send(payload);
    }
  }

  roomSize(lobbyId: string): number {
    return this.rooms.get(lobbyId)?.size ?? 0;
  }

  hasRoom(lobbyId: string): boolean {
    return this.rooms.has(lobbyId);
  }

  roomCount(): number {
    return this.rooms.size;
  }
}

export function createLiveHub(): LiveHub {
  return new Hub();
}
