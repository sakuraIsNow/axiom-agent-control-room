declare module 'word-extractor' {
  class WordDocument {
    getBody(): string;
  }

  export default class WordExtractor {
    extract(input: Buffer): Promise<WordDocument>;
  }
}
