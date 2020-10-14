import * as _ from 'lodash';
const fs = require('fs');
const path = require('path');
import { format, parse } from 'fast-csv';
import { Stream } from 'stream';

type RowType = {
  checksum: string,
  timestamp: number,
  success: boolean,
  recall: number,
};

class History {

  recallHistory: Object = {};

  constructor () {
    
  }

  destructor () {
    Object.getOwnPropertyNames(this.recallHistory).forEach(folderPath => {
      this.recallHistory[folderPath].stream.end();
    });
  }

  /**
   * Adds a folder to the mix, loads history, sets up the writer stream
   * 
   * @param folderPath Normalized absolute path to the workspace folder that should be added
   */
  async addFolder (folderPath: string) {
    if (!this.recallHistory[folderPath]) {
      console.log('Setting recall history', folderPath);
      const folderHistory = {
        // Object with card review history
        cards: Promise.resolve({}),

        // Writer stream
        // stream: process.stdout
        stream: format({ includeEndRowDelimiter: true })
      };
      this.recallHistory[folderPath] = folderHistory;

      // Make sure the log folder exists
      const logPath = path.join(folderPath, '.recall');
      fs.mkdirSync(logPath, { recursive: true });

      folderHistory.stream.pipe(fs.createWriteStream(
        path.join(logPath, `recall-${new Date().toISOString().substr(0, 10)}.csv`), 
        { flags: 'a' } // 'a' means appending (old data will be preserved)
      ));

      // Load the history
      // NOTE: the .cards attribute is actually a Promise that resolves to an object
      folderHistory.cards = this.loadCardHistory(logPath);

      return folderHistory.cards;
    }
  }

  /* async */ loadCardHistoryCSV (filePath) {
    return new Promise<RowType[]>((resolve, reject) => {
      let result = [];
      try {
        fs.createReadStream(filePath)
          .pipe(parse({ headers: ['checksum', 'timestamp', 'success', 'recall'] }))
          .transform(row => ({
            checksum: row.checksum,
            timestamp: parseInt(row.timestamp),
            success: !!parseInt(row.success),
            recall: parseInt(row.recall),
          }))
          .on('error', reject)
          .on('data', row => { result.push(row); })
          .on('end', () => resolve(result));
      }
      catch (e) {
        console.error(e);
        reject(e);
      }
    });

  }

  async loadCardHistory (logPath) {
    // Load all existing history files
    const globby = require('globby'); // Lazy import for performance
    const files = await globby('recall-*.csv', { cwd: logPath, absolute: true });
    // console.log('Reading history files', files);

    // console.log('Recall history set', logPath);

    const historyLog:RowType[] = _.flatten(await Promise.all(files.map(this.loadCardHistoryCSV)));

    return historyLog.reduce((result, row:RowType) => {
      const { checksum, ...review } = row;
      if (result[checksum]) result[checksum].push(review);
      else result[checksum] = [review];
      return result;
    }, {});
  }

  logCardRecall (card, success) {
    const folderHistory = this.recallHistory[card.rootPath];
    if (!folderHistory) {
      console.warn('Folder not initialized', card.rootPath);
      return;
    }

    folderHistory.cards.then(cards => {
      const cardHistory = cards[card.checksum] || [];
      // TODO: Update card history

      console.log('Card history for ', card.rootPath, cards);
  
      const csvData = [card.checksum, Date.now(), success ? 1 : 0, card.recall];
      console.log('Writing card to log', card, csvData);
  
      try {
        const result = folderHistory.stream.write(csvData);
        console.log('Write result', result);
      }
      catch (e) {
        console.error(e);
      }
    });
  }

  async getCardRecall (card) {
    const folderHistory = this.recallHistory[card.rootPath];
    if (!folderHistory) {
      console.warn('Folder not initialized', card.rootPath);
      return;
    }

    folderHistory.cards.then(cards => {
      const cardHistory = cards[card.checksum] || [];

      cardHistory.forEach(review => {
        const nextReviewDate = new Date(review.timestamp + review.recall * 24 * 3600 * 1000);
        if (nextReviewDate > card.nextReviewDate) {
          card.nextReviewDate = nextReviewDate;
          card.recall = review.recall;
        }
      }, { nextReviewDate: 0 });
    });
  }
}

export default History;