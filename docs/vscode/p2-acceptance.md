# VS Code P2 Beginner Acceptance Tutorial

English | [中文](p2-acceptance.zh.md)

This tutorial is for an acceptance tester using VS Code commands, the Extension Development Host, and DSH for the first time. When finished, you will have verified the complete P2 coding loop in a temporary folder outside the repository, without using development files for write tests.

Status: the complete procedure passed user acceptance on 2026-08-25 and remains the reusable regression procedure for the accepted P2 baseline.

## Read This Before Starting

- Every step explains what to do, what counts as a pass, and how to handle a problem. Follow the steps in order; stop at a failed step instead of continuing with an error.
- Approve writes only inside the temporary `E:\E_AI\DSH\vscode-p2-acceptance` folder. Choose **拒绝** when an approval card shows another path or a command you do not understand.
- Model configuration requires your own OpenAI-compatible provider URL, model ID, and rotated API key. Enter the API key only in the password box; never put it in a file, VS Code settings JSON, screenshot, or acceptance report.
- The notation `Ctrl+Shift+P` means hold `Ctrl` and `Shift`, press `P` once, then release the keys.

### What “Run a Command” Means

VS Code gives `Ctrl+P` and `Ctrl+Shift+P` different jobs. `Ctrl+P` finds files; entering a command name there commonly produces “no matching results.” `Ctrl+Shift+P` opens the Command Palette, whose input starts with `>`.

Whenever an instruction says “run **DSH：Some Command**,” press `Ctrl+Shift+P`, type the command name, then click the result or press `Enter`. A visible button with the same purpose is an equivalent shortcut.

For the box in the supplied screenshot, press `Esc` to close it. To configure a model, click the gear at the upper right of the DSH view, then click **配置并保存模型**; it performs the same action as **DSH：配置 OpenAI 兼容模型**.

## 1. Open the Repository in Regular VS Code

### What to Do

1. Close the search box shown in the screenshot by pressing `Esc` once. You may leave that VS Code window open for the moment.
2. Open a regular **Visual Studio Code** window from the Windows Start menu.
3. Click **File**, then **Open Folder**.
4. Select `E:\E_AI\DSH\deepseek-harness-myPcVs`, then click **Select Folder**.
5. If VS Code asks whether to trust the folder, verify that the path exactly matches the repository path above before choosing to trust it.

### What Counts as a Pass

The lower-left status bar shows the `master` branch, and the Explorer shows directories such as `apps`, `docs`, and `packages`.

### If Something Is Different

If you opened one file instead of the whole folder, use **File → Open Folder** again. If the path differs, do not continue to the build; send the actual path to the developer for confirmation.

## 2. Build the Extension and Create a Temporary Test Folder

### What to Do

1. In the regular VS Code window, click **Terminal**, then **New Terminal**.
2. A PowerShell terminal starting with `PS E:\E_AI\DSH\deepseek-harness-myPcVs>` appears at the bottom.
3. Copy the following five commands one at a time. Paste one line into the terminal, press `Enter`, wait for the `PS ...>` prompt to reappear, then run the next line.

```powershell
pnpm run build:lib:host
pnpm --filter @deepseek-ai/dsh-vscode run build
New-Item -ItemType Directory -Force -Path "E:\E_AI\DSH\vscode-p2-acceptance" | Out-Null
Set-Content -LiteralPath "E:\E_AI\DSH\vscode-p2-acceptance\value.txt" -Value "alpha" -NoNewline
code --new-window --extensionDevelopmentPath="E:\E_AI\DSH\deepseek-harness-myPcVs\apps\vscode\extension" "E:\E_AI\DSH\vscode-p2-acceptance"
```

Do not launch this acceptance window with `F5` alone. The new Extension Development Host must show `vscode-p2-acceptance` as its open folder; a Welcome window has no project directory and DSH will ask you to open a folder instead of starting from the VS Code installation directory.

4. The last command opens another VS Code window. Perform the remaining acceptance steps only in this new window; leave the original repository window open because the final restart check uses it again.

### What Counts as a Pass

Both build commands finish and return to the PowerShell prompt without `ERR_PNPM` or a build failure. The new window's Explorer shows only the temporary folder contents, including a `value.txt` file whose content is `alpha`.

### If Something Is Different

If the terminal cannot find `pnpm`, `code`, or a path, stop acceptance and send the complete error screenshot to the developer. A yellow warning is acceptable when the build ultimately returns to the prompt; do not continue after a red error or a command that never finishes.

## 3. Identify the Acceptance Window and Configure the Runtime Path

### What to Do

1. Look at the Secondary Side Bar on the right of the new window. The **DeepSeek Harness** **编码助手** view should already be there. If the right sidebar is closed, use **View → Appearance → Secondary Side Bar** to show it.
2. Click the gear icon in the lower-left corner of VS Code, then click **Settings**.
3. Enter `dsh runtime` in the Settings search box.
4. Find **Dsh › Runtime: Command** and change its value to `C:\Program Files\nodejs\node.exe`.
5. Find **Dsh › Runtime: Args**. Remove the existing `--profile` and `vscode` items, then add these three items in order:

```text
E:\E_AI\DSH\deepseek-harness-myPcVs\apps\cli\lib\bin.js
--profile
vscode
```

6. Leave **Dsh › Runtime: Cwd** empty. Close the Settings tab and return to **DeepSeek Harness** on the right.

### What Counts as a Pass

The top of the DSH view contains **启动**, a gear button, a conversation selector, and a prominent **＋ 新建对话** button. The bottom contains **＋ 选区**, **＋ 当前文件**, **＋ 工作区**, **＋ Skill**, the composer, **取消**, and **发送**.

### If Something Is Different

If these settings are absent, confirm that the search box contains `dsh runtime` and that you are working in the new window opened by step 2. Never place an API key in any runtime setting.

## 4. Start DSH

### What to Do

1. Click the blue **启动** button at the top of the DSH view.
2. Wait for the status to change from **正在启动……** to **已连接**; this normally takes a few seconds.

### What Counts as a Pass

The status shows green **已连接**, and the top **启动** button disappears. The status bar also reports that DSH is connected.

### If Something Is Different

If the view shows **连接失败**, click the gear and then **查看输出** in the Runtime card. `spawn dsh ENOENT` means the Command value in step 3 was not applied; `Cannot find module` pointing to `apps\cli\lib\bin.js` means the build in step 2 did not succeed. Screenshot any other error after hiding credentials.

## 5. Configure the Model

### What to Do

1. Click the gear at the upper right of the DSH view, then click **配置并保存模型** on the separate **DSH 设置** page. Do not use the box in the screenshot that reports no matching results.
2. The configuration wizard contains six input boxes. Complete each one and press `Enter` to continue:

   1. **Provider route**: enter a local name containing only lowercase letters, digits, and hyphens, such as `acceptance-provider`.
   2. **Provider name**: enter a display name such as `Acceptance Provider`.
   3. **API base URL**: paste the OpenAI-compatible API URL from the provider documentation, usually ending in `/v1`. Do not guess the URL.
   4. **Model ID**: enter the exact model ID accepted by the provider.
   5. **Model name**: enter the name to show in selectors; it may match Model ID when uncertain.
   6. **API key**: paste the rotated replacement key. Dots instead of visible characters are expected.

3. After the sixth input, wait for DSH to restart automatically and return to **已连接**, then click **完成并返回对话**.

### What Counts as a Pass

A notification similar to `已保存模型 acceptance-provider/model-id，新对话会使用此模型。` appears, then DSH returns to **已连接**. Before a conversation exists, the model selector on the Settings page may show **尚无可用模型**; step 6 loads the catalog after creating and selecting a conversation.

### If Something Is Different

If **配置并保存模型** does nothing, confirm that the status is **已连接**, then click it again. If the Command Palette is required, press `Ctrl+Shift+P` and enter `DSH：配置 OpenAI 兼容模型`; the input must start with `>`. If no result still appears, this is not the new window with the development extension, so relaunch it from step 2. After the success notification appears, do not re-enter the API key because **尚无可用模型** is still visible.

## 6. Create a Session and Select Confirm Changes

### What to Do

1. Click the prominent **＋ 新建对话** button near the top of the DSH view.
2. Wait for a new entry to appear in the conversation selector.
3. Click the gear and check that the model selector names the model configured in step 5.
4. Choose **修改前确认** in the permission selector, then click **完成并返回对话**.
5. Wait until the view no longer reports a running operation.

### What Counts as a Pass

The Settings page shows the provider and model configured in step 5 and permission **修改前确认**. After returning, the composer becomes editable and **发送** becomes available.

### If Something Is Different

If **＋ 新建对话** or the gear is absent, confirm that VS Code is at least 1.106 and step 4 shows **已连接**. Wait ten seconds after creating a conversation; if Settings still shows **尚无可用模型** or **当前模型不可用**, click **查看输出** and report its last lines instead of configuring the provider or entering the API key again.

## 7. Verify an Ordinary Conversation and Tool Cards

### What to Do

1. Click the composer at the bottom of DSH and paste the complete task below:

```text
请列出当前工作区的文件，并读取 value.txt，告诉我文件内容。不要修改任何文件。
```

2. Click **Send**. Do not press other controls until the response finishes.

### What Counts as a Pass

Your message appears first, followed by progressively rendered assistant text that eventually loses its `streaming` marker. File-reading or directory-listing tool cards move from running to completed, the answer says that `value.txt` contains `alpha`, and the file itself remains `alpha`.

### If Something Is Different

An authentication, unknown-model, or network error means the first real request did not pass; return to step 5 and verify Base URL, Model ID, and API key. If the answer completes without a tool card, send “必须使用文件读取工具读取 value.txt”; record this step as failed if no card appears again.

## 8. Verify Selection, File, and Workspace Context

### What to Do

1. Click `value.txt` in Explorer so it appears in the central editor.
2. Drag across `alpha` so all five letters remain highlighted.
3. Return to the DSH view and click **+ Selection**. A selection chip containing `value.txt:1-1` should appear above the composer.
4. Click **+ File**. A file chip should appear.
5. Click **+ Workspace**. A workspace chip should appear.
6. Click `×` on the workspace chip and confirm that only this chip disappears.
7. Paste the following task into the composer and click **Send**:

```text
只根据我附加的上下文，说明文件名、选区行号和文本内容。不要修改文件。
```

### What Counts as a Pass

The selection and file chips are visible before sending, while the workspace chip has been removed. After the Host accepts the task, the composer and chips clear; the assistant identifies `value.txt`, line 1, and `alpha`. The file remains unchanged.

### If Something Is Different

If **+ Selection** says to select text first, the highlight was not retained; return to the editor and select it again. If **+ Workspace** says that more than 200 files exist, the temporary test folder is not open, so return to step 2.

## 9. Verify a Project Skill

### What to Do

1. Click **+ Skill** above the DSH composer.
2. When **Create Project Skill** appears, enter `acceptance-helper` and press `Enter`.
3. VS Code opens an already valid `SKILL.md` skeleton. Do not press `Ctrl+A` or replace the entire file. Confirm that the first line is exactly `---`, not ```` ```markdown ````.
4. Change only the `description:` line to `description: Use when checking the VS Code P2 acceptance flow.`, then replace `Write the reusable workflow here.` with ``Begin the response with `SKILL_OK`.`` and press `Ctrl+S`. The last line must not be ```` ``` ````.
5. Click the **DeepSeek Harness** icon to return to the composer, then enter a single `/` into the empty composer.
6. Click the `/acceptance-helper` option, append the following text, and click **Send**:

```text
请只回复一句简短确认，不要修改文件。
```

7. Click **+ Skill** again, enter `acceptance-helper` again, confirm that VS Code reports the existing Skill, then dismiss the message.

### What Counts as a Pass

The first line of `SKILL.md` is `---`, and the file contains no ```` ```markdown ```` or standalone ```` ``` ```` line. Typing `/` shows `/acceptance-helper` without a runtime restart; the sent prompt starts with `/acceptance-helper`; the assistant response starts with `SKILL_OK`. Duplicate creation fails without replacing the original file.

### If Something Is Different

If `/acceptance-helper` is absent, open `SKILL.md`: delete any code-fence marker lines at its start or end and press `Ctrl+S`; wait one second, return to the composer, remove `/`, then type it again. If the menu contains `/acceptance-helper` but sending it reports an unknown command, stop and record a Host routing failure; do not recreate the Skill. Stop and record a failure if duplicate creation overwrites the file.

## 10. Verify Rejecting a File Change

### What to Do

1. Confirm that the Settings page permission remains **修改前确认** and `value.txt` still contains `alpha`.
2. Paste the following task into DSH and click **Send**:

```text
请使用文件编辑工具把 value.txt 中唯一的 alpha 改成 beta。只修改这一处，不要使用 Shell。
```

3. Wait for the conversation to scroll to the bottom and show the prominent yellow-bordered **需要你的审批** panel immediately above the composer. It may briefly say **正在准备审阅……** while history catches up; wait until the card names `value.txt` and contains **打开差异**, **拒绝**, and **仅允许这一次**.
4. Click **打开差异**. VS Code opens a side-by-side comparison with `alpha` on the left and `beta` on the right.
5. After inspecting it, close the Diff tab, return to the bottom of DSH, and click **拒绝**.
6. Open `value.txt` again and inspect its content.

### What Counts as a Pass

The Diff shows only `alpha` changing to `beta`. After **拒绝**, the approval settles, `value.txt` remains byte-for-byte equal to `alpha`, and the conversation contains a rejected tool result.

### If Something Is Different

If the model chooses Shell, click **拒绝** and retry while emphasizing that it must use a file-edit tool. If **无法生成审阅** remains or **仅允许这一次** stays disabled after **正在同步对话记录……** disappears, report a failure. If synchronization or preparation lasts more than ten seconds, open Settings, click **查看输出**, and report the last lines without reconfiguring the model. If the file becomes `beta` before approval, or a file edit can be allowed without a Diff, stop immediately and report a failure.

## 11. Verify That a Stale Diff Cannot Overwrite a Manual Edit

### What to Do

1. Send the same edit task from step 10 and wait for the approval card, but do not click an approval control yet.
2. Open the original `value.txt`, manually change `alpha` to `alpha-manual`, and press `Ctrl+S`.
3. Return to the approval card at the bottom and click **仅允许这一次**.
4. Reopen `value.txt` and inspect its content.
5. After inspection, manually restore the file to `alpha` and press `Ctrl+S` to prepare for the next step.

### What Counts as a Pass

The extension reports that the pending Diff is stale and rejects execution; the file remains `alpha-manual` instead of being overwritten with `beta`. After manual restoration, the file contains `alpha`.

### If Something Is Different

If the file becomes `beta` after **仅允许这一次**, stale-preview protection failed; stop acceptance and report this step as failed.

## 12. Verify Allow Once

### What to Do

1. Confirm that `value.txt` contains `alpha` and Settings permission is **修改前确认**.
2. Send the same edit task from step 10 again.
3. Click **打开差异** and confirm again that the left side is `alpha`, the right side is `beta`, and no other file or change appears.
4. Return to the approval card, click **仅允许这一次**, and wait for the tool and assistant response to finish.
5. Open `value.txt` and inspect its content.

### What Counts as a Pass

Only the displayed operation runs, and `value.txt` becomes `beta`. The approval and tool cards both settle into final states; a later change does not inherit this approval.

### If Something Is Different

Stop and report a failure if the file differs from the right side of the Diff, an extra file changes, or one approval automatically authorizes a later operation.

## 13. Verify Shell Command Approval

### What to Do

1. Confirm that Settings permission is **修改前确认**.
2. Paste the following task and click **Send**:

```text
请只使用 Shell 运行下面这条 PowerShell 命令，不要改写命令，也不要调用其他修改工具：Set-Content -LiteralPath '.\shell-check.txt' -Value 'SHELL_OK' -NoNewline
```

3. When the approval card appears, verify that the command targets only `shell-check.txt`, the working directory is `E:\E_AI\DSH\vscode-p2-acceptance`, and the card warns that Shell filesystem effects cannot be predicted completely like a Diff.
4. Click **仅允许这一次** only when all three facts are exact; otherwise click **拒绝** and record the difference.
5. Wait for completion, then open `shell-check.txt` in Explorer.

### What Counts as a Pass

The file is absent before approval; after approval it appears with content exactly equal to `SHELL_OK`. The tool card shows command completion, and the approval applies only to this command.

### If Something Is Different

Record a failure if the file is created without approval or the card does not show the exact command, working directory, and effects warning. Never approve a command targeting anything outside the temporary folder.

## 14. Verify All Three Permissions and Cancellation

### What to Do

1. Open **DSH 设置** with the gear, choose **只读** in the permission selector, and return to the conversation.
2. Ask the agent to “使用文件编辑工具把 `value.txt` 的 `beta` 改成 `gamma`”.
3. Confirm that the operation fails without **仅允许这一次**, then check that the file remains `beta`.
4. Return to **DSH 设置**, choose **允许工作区修改**, and return to the conversation.
5. Again ask the agent to “使用文件编辑工具把 `value.txt` 的 `beta` 改成 `gamma`” and wait for completion.
6. Confirm that no approval card appears and the file automatically becomes `gamma`.
7. Ask the agent to create `E:\E_AI\DSH\vscode-p2-outside-acceptance.txt`. It must fail or request approval; click only **拒绝** if approval appears.
8. Send the longer task below and immediately click **Cancel** while the assistant is still running:

```text
请逐项检查当前工作区的全部文件，给出非常详细的内容说明，但不要修改任何文件。
```

### What Counts as a Pass

Read-only mode cannot write and offers no allow control; workspace-write mode automatically changes `beta` to `gamma` inside the test workspace; no outside-workspace write executes. After Cancel stops the active turn, the composer and session remain usable.

### If Something Is Different

If the response finishes too quickly to click Cancel, send a longer read-only analysis task and try again. Stop immediately and report the full path if any mode actually creates a file outside the workspace.

## 15. Verify Runtime Restart and Window-Reopen Recovery

### What to Do

1. Note the current conversation title, the permission value on Settings, and the `gamma` content of `value.txt`.
2. Open **DSH 设置**, click **重新启动**, wait for **已连接**, and return to the conversation.
3. Confirm that the original conversation remains selected; if it does not, select it again from the conversation selector.
4. Scroll through the conversation and verify that the Skill response, rejection record, approved Diff, Shell result, and permission changes remain, with one copy of each.
5. Click **查看输出** on Settings and confirm that it does not contain the complete API key. Do not enter the key into a search box to perform this check.
6. Close this Extension Development Host window, but leave the regular repository window from step 1 open.
7. Return to the PowerShell terminal in the regular repository window and rerun this command:

```powershell
code --new-window --extensionDevelopmentPath="E:\E_AI\DSH\deepseek-harness-myPcVs\apps\vscode\extension" "E:\E_AI\DSH\vscode-p2-acceptance"
```

8. In the reopened window, use **DeepSeek Harness** on the right, click **启动**, and wait for **已连接**.
9. Select the previous conversation, then inspect its history and open Settings to check model and permission again.

### What Counts as a Pass

After both a runtime restart and a complete development-window reopen, the same session, history, model, permission, tool results, and approved edit return without duplicate messages. Draft-only context chips do not return, and the API key does not need to be entered again.

### If Something Is Different

If the session list is empty, first confirm that the reopened workspace is still `E:\E_AI\DSH\vscode-p2-acceptance`. If output contains the complete API key, do not screenshot or copy that line; close the window immediately and report “the output leaked the key.”

## 16. Record the Acceptance Result

### What to Do

Reply to the developer in the following format. A passing step needs only “pass”; for a failed step, include the visible text and a screenshot or Output with API keys, tokens, cookies, and Authorization headers removed.

```text
P2 验收结果
1：通过/失败
2：通过/失败
3：通过/失败
4：通过/失败
5：通过/失败
6：通过/失败
7：通过/失败
8：通过/失败
9：通过/失败
10：通过/失败
11：通过/失败
12：通过/失败
13：通过/失败
14：通过/失败
15：通过/失败

第一个失败步骤看到的提示：
已脱敏的截图或 Output：
```

### What Counts as a Pass

Complete P2 acceptance passes when steps 1–15 all meet their pass criteria and step 12 completes one Diff-reviewed file change. After acceptance, you may delete the entire `E:\E_AI\DSH\vscode-p2-acceptance` temporary folder.

### If Something Is Different

You do not need to analyze the code yourself. Report only the first failed step, the exact visible text, and redacted output, then wait for a developer fix or next instruction; do not repeatedly click Allow once to experiment.
