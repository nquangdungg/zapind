export enum ThreadType {
  User = 0,
  Group = 1,
}

export enum ClientStatus {
  Idle = 'idle',
  Starting = 'starting',
  QRPending = 'qr_pending',
  Scanned = 'scanned',
  Connected = 'connected',
  Error = 'error',
}

export enum Gender {
  Male = 'male',
  Female = 'female',
  Unknown = 'unknown',
}

export enum GroupType {
  Group = 'group',
  Community = 'community',
}

export enum CloseReason {
  ManualClosure = 1000,
  AbnormalClosure = 1006,
  DuplicateConnection = 3000,
  KickConnection = 3003,
}

export enum TextStyle {
  Bold = 'b',
  Italic = 'i',
  Underline = 'u',
  StrikeThrough = 's',
  Red = 'c_db342e',
  Orange = 'c_f27806',
  Yellow = 'c_f7b503',
  Green = 'c_15a85f',
  Small = 'f_13',
  Big = 'f_18',
  UnorderedList = 'lst_1',
  OrderedList = 'lst_2',
  Indent = 'ind_$',
}

export enum Urgency {
  Default = 0,
  Important = 1,
  Urgent = 2,
}

export enum Reaction {
  Heart = '/-heart',
  Like = '/-strong',
  Haha = ':>',
  Wow = ':o',
  Cry = ':-((',
  Angry = ':-h',
  None = '',
}
