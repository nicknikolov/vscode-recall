
/* IMPORT */

import * as _ from 'lodash';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import Config from '../config';
import Utils from '../utils';
import { createCommandUrl } from '../commands';

const ARCHIVE_RECALL = 10000;

async function open () {

  // Only allow one instance to exist
  // see https://code.visualstudio.com/api/extension-guides/webview#visibility-and-moving
  if (Utils.panel) {
    Utils.panel.reveal();
    return;
  }

  // Create and show panel
  const panel = vscode.window.createWebviewPanel(
    'recallTest',
    'Recall: Flashcards Test',
    vscode.ViewColumn.One,
    {
      // Only allow the webview to access resources in our extension's media directory
      //localResourceRoots: [vscode.Uri.file(path.join(Utils.context.extensionPath, 'src', 'views'))],
      // Enable scripts in the webview
      enableScripts: true,
      enableCommandUris: true,
    }
  );
  Utils.panel = panel;

  const onDiskPath = vscode.Uri.file(path.join(Utils.context.extensionPath, 'resources', 'css', 'card.css'));
  const styleSrc = panel.webview.asWebviewUri(onDiskPath);

  // Show loading message
  panel.webview.html = await getWebviewContent(styleSrc, 'Loading ...', null);

  await Utils.embedded.initProvider ();
  let cardProvider = Utils.embedded.provider;

  await cardProvider.get ( undefined, null );

  let currentCard = null, pagesShown = 1;

  // Get new card limits from configuration
  const config = Config(null);
  let newCardCounter:number = config.get('newCardLimit') || Number.MAX_SAFE_INTEGER, skipNewCardCount = 0;

  function showNextCard() {
    currentCard = cardProvider.getNextCard();
    pagesShown = 1;

    // Limit the number of new cards for review
    if (!currentCard || currentCard.recall || (newCardCounter-- > 0)) {
      rerender();
    }
    else {
      skipNewCardCount++
      skipCard();
    }
  }

  function skipCard () {
    currentCard.nextReviewDate = Date.now() + 24 * 3600 * 1000;
    showNextCard();
  }

  function expandCard() {
    pagesShown++;
    rerender();
  }

  function toggleArchiveCard() {
    if (currentCard.recall > ARCHIVE_RECALL) currentCard.recall -= ARCHIVE_RECALL;
    else currentCard.recall += ARCHIVE_RECALL;
    rerender();
  }

  function rerender () {
    let fallbackMessage = [ '<p>No cards to review. Well done!</p>' ];
    if (skipNewCardCount) fallbackMessage.push(`<p><i>(${skipNewCardCount} new cards were automatically skipped, run the review again to go over them)</i></p>`);
    getWebviewContent(styleSrc, fallbackMessage.join('\n'), currentCard, pagesShown)
      .then(html => panel.webview.html = replaceRelativeMediaPaths(html))
      .catch(console.error);
  }

  function replaceRelativeMediaPaths (html) {

    const basePath = currentCard ? currentCard.rootPath : '';
    const subdirPath = currentCard ? currentCard.subdirPath : '';

    // Replacer function - 
    function replacer (match, relPath, offset, str) {
      const onDiskPath = path.isAbsolute(relPath) ? relPath : path.join(basePath, subdirPath, relPath);
      return `src="${panel.webview.asWebviewUri(vscode.Uri.file(onDiskPath))}"`;
    }
  
    return html.replace(/src="([^"]*)"/, replacer);
  
  }
  
  showNextCard();

  // Handle messages from the webview
  panel.webview.onDidReceiveMessage(
    message => {
      if (message === 'next') {
        skipCard();
        return;
      }

      // console.log(message);
      if(pagesShown < currentCard.pages.length) {
        if (message === 'expand') expandCard();
      }
      else {
        if (message === 'archive') toggleArchiveCard();
        else {
          // Don't archive when "forgot" is sent
          if (message === 'forgot') {
            if(currentCard.recall > ARCHIVE_RECALL) currentCard.recall -= ARCHIVE_RECALL;
            cardProvider.processReviewResult(currentCard, 0.5);
            showNextCard();
          }
          else if (message === 'struggled') {
            cardProvider.processReviewResult(currentCard, 1);
            showNextCard();
          }
          else if (message === 'remembered') {
            cardProvider.processReviewResult(currentCard, 2);
            showNextCard();
          }
        }
      }
    },
    undefined,
    Utils.context.subscriptions
  );

  panel.onDidDispose(
    () => {
      Utils.panel = null;

      Utils.embedded.provider.history.destructor();
      Utils.embedded.provider = undefined;
    },
    null,
    Utils.context.subscriptions
  );

}

async function getWebviewContent(styleSrc, fallbackMessage, card, pagesShown = 1) {
  console.log('Showing card', card);

  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="stylesheet" type="text/css" href="${styleSrc}">
    <title>Recall: Flashcards Test</title>
</head>
<body>
    <div class="container">
    ${card ? await renderCard(card, pagesShown) : fallbackMessage}
    </div>
    <script>
      (function() {
        const vscode = acquireVsCodeApi();
        addOnClickHandler('expand');
        addOnClickHandler('remembered');
        addOnClickHandler('struggled');
        addOnClickHandler('forgot');

        function onButtonClick(id) {
          // console.log(id);
          vscode.postMessage(id);
        }

        function addOnClickHandler(id) {
          const btn = document.getElementById(id);
          console.log(btn);
          btn.onclick = function (e) { onButtonClick(id); };
        };

        document.body.onkeypress = function(e) { 
          if (e.code === 'Space') onButtonClick('expand');
          else if (e.code === 'Enter') onButtonClick('remembered');
          else if (e.code === 'KeyF' ) onButtonClick('forgot');
          else if (e.code === 'KeyA' ) onButtonClick('archive');
          else if (e.code === 'KeyN' ) onButtonClick('next');
          else console.log(e);
        };
      }());
    </script>
</body>
</html>`;
}

/* Card render */
async function renderPage(pageText) {
  return await vscode.commands.executeCommand ( 'markdown.api.render', pageText );
}

async function renderCard (card, pagesShown) {
  const renderedPages = await Promise.all(card.pages.map(async (text, i) => {
    return `<div class="${i ? 'back' : 'front'}" style="${i < pagesShown ? '' : 'display: none;'}">${await renderPage(text)}</div>`;
  }));

  const headerDivider = ' \u25B6 ';

  return `<div class="preamble">
    <span>${card.recall ? '' : '<span class="label">NEW</span>'}<b>${card.root}</b> / ${card.relativePath}${card.headerPath.length ? headerDivider : ''}${card.headerPath.join(headerDivider)}</span>
    <span><a href="${createCommandUrl('editFile', card.filePath, card.offset)}">Edit</a></span>
  </div>
  <div class="card">
    ${renderedPages.join('\n')}
    <div class="buttons" style="${pagesShown < card.pages.length ? '' : 'display: none;'}">
      <a id="expand" href="#" class="btn" onclick="console.log">Expand</a>
    </div>
    <div class="buttons" style="${pagesShown === card.pages.length ? '' : 'display: none;'}">
      <a id="remembered" href="#" class="btn">Remembered (Enter)</a>
      <a id="struggled" href="#" class="btn">Struggled</a>
      <a id="forgot"   href="#" class="btn">Forgot (F)</a>
    </div>
    <div class="buttons" style="${card.recall > ARCHIVE_RECALL ? '' : 'display: none;'}">
      <span class="warning">Press Enter to archive the card.</span>
    </div>
  </div>
  <div class="postscript">
    <span>Id: ${card.checksum}</span>
    <span>Recall: ${card.recall}</span>
  </div>`;
}

/* EXPORT */

export {
  open
};
