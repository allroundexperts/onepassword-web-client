import base64safe from "urlsafe-base64";
import {find, flatten} from "lodash";
import NodeRSA from "node-rsa";
import {Cipher} from "./services/Cipher";
import {Onepassword} from "./services/Onepassword";
import {
  Client,
  DecryptedItemDetail,
  DecryptedItemOverview,
  Device,
  Entry,
  EntryCredentials,
  EntryDetail,
  RawEntry
} from "./types";
import {extractOtp, getKey} from "./utilities";
import { defaultDevice } from "./config";

export default class OnepasswordClient implements Client {
  public  device: Device;
  private cipher: Cipher;
  private onepassword: Onepassword;
  private masterKeys: Record<string, NodeRSA>;

  public constructor(device : object = {}) {
    this.device = {
      ...defaultDevice,
      ...device
    };
    this.cipher = new Cipher();
    this.onepassword = new Onepassword(this.device);
  }

  public async login(
    password: string,
    email: string,
    secret: string
  ): Promise<void> {
    const key = getKey(secret);
    this.cipher.setKey(key);
    const { userAuth, sessionID } = await this.onepassword.auth(email, key);
    const { bigA, littleA } = await this.cipher.generateSRPKeys();
    const { bigB } = await this.onepassword.SRPExchange(sessionID, bigA);
    this.cipher.setAuth({ ...userAuth, email, password, littleA, bigA, bigB });
    const sessionKey = bigB ? await this.cipher.getSessionKey(sessionID) : null;
    this.onepassword.setSession({ id: sessionID, key: sessionKey });
    this.cipher.setSession({ id: sessionID, key: sessionKey });
    const clientHash = this.cipher.clientVerifyHash();
    const serverHash = this.cipher.serverVerifyHash(clientHash);
    await this.onepassword.verifySessionKey(clientHash, serverHash);
    const encKeySets = await this.onepassword.getKeySets();
    this.masterKeys = this.cipher.getMasterPrivateKeys(encKeySets);
  }

  public async getEntries(): Promise<Entry[]> {
    const vaults = await this.onepassword.getVaults();
    const entries = vaults.map(async ({ uuid, access }) => {
      const [{ encVaultKey, encryptedBy }] = access;
      const { k } = this.cipher.decipher(
        encVaultKey,
        this.masterKeys[encryptedBy]
      );
      const vaultKey = base64safe.decode(k);
      let items = await this.onepassword.getItemsOverview(uuid);
      items = items.filter(i=>i.trashed !== 'Y');
      return items.map(({ encOverview, uuid: itemId }) => {
        const { url, title, tags, ainfo } = this.cipher.decipher(
          encOverview,
          vaultKey
        ) as DecryptedItemOverview;
        return {
          id: `${uuid}:${itemId}`,
          url: url,
          name: title,
          type: tags && tags.length ? tags[0] : null,
          username: ainfo
        };
      });
    });
    return flatten(await Promise.all(entries));
  }

  public async getEntryCredentials(id: string): Promise<EntryCredentials> {
    const {fields, sections} = await this.getEntryDetails(id);
    const username = find(fields, ["designation", "username"]);
    const password = find(fields, ["designation", "password"]);
    const otp = extractOtp(sections);
    return {
      username: username ? username.value : "",
      password: password ? password.value : "",
      otp
    };
  }

  private async getEntryDetails(id: string) : Promise<DecryptedItemDetail>{
    const [vaultID, uuid] = id.split(":");
    const vaults = await this.onepassword.getVaults();
    const {
      access: [{encVaultKey, encryptedBy}]
    } = find(vaults, ["uuid", vaultID]);
    const {k: vaultKey} = this.cipher.decipher(
        encVaultKey,
        this.masterKeys[encryptedBy]
    );
    const {encDetails} = await this.onepassword.getItemDetail(uuid, vaultID);
    return this.cipher.decipher(
        encDetails,
        base64safe.decode(vaultKey)
    ) as DecryptedItemDetail;
  }

  public async getEntry(id: string): Promise<EntryDetail> {
    const rawItemDetail = await this.getEntryDetails(id);
      return OnepasswordClient.mapToItemDetails(rawItemDetail);
  }

  private static mapToItemDetails(rawItemDetail: DecryptedItemDetail): EntryDetail {
    let sections = rawItemDetail.sections ?
        rawItemDetail.sections.map((rawSection) => {
          let fields = rawSection.fields ?
              rawSection.fields.map((rawField) => {
                return {id: rawField.n, type: rawField.k, title: rawField.t, value: rawField.v}
              })
              : undefined;
          return {
            name: rawSection.name,
            title: rawSection.title,
            fields: fields
          }
        })
        : undefined;
    return {
      fields: rawItemDetail.fields,
      notesPlain: rawItemDetail.notesPlain,
      password: rawItemDetail.password,
      sections: sections,
      username: rawItemDetail.username
    };
  }

  public async addEntry(entry: RawEntry): Promise<string> {return '';}
}
