# Orchebary shell integration: emits FinalTerm/VS Code escape sequences so the
# renderer can segment output into command blocks.
#   OSC 133;A  prompt start        OSC 133;B  prompt end / input start
#   OSC 133;C  command executed    OSC 133;D;<exit>  command finished
#   OSC 633;E;<cmd>  exact command line    OSC 7  cwd report
#
# Sourced automatically via the ZDOTDIR shim. Can also be sourced manually:
#   source /path/to/orchebary-integration.zsh

[[ -o interactive ]] || return 0
[[ -n "$ORB_SESSION_ID" ]] || return 0
# Guard against double-sourcing in the same shell (not exported on purpose:
# nested interactive shells should run their own integration).
[[ -n "$__orb_integration_active" ]] && return 0
typeset -g __orb_integration_active=1
typeset -g __orb_in_command=''
typeset -g __orb_prompted=''

builtin autoload -Uz add-zsh-hook

__orb_osc() {
  builtin printf '\e]%s\a' "$1"
}

# Escape for OSC 633;E payload: backslash, semicolon, newline.
__orb_escape() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//;/\\x3b}
  s=${s//$'\n'/\\x0a}
  builtin print -rn -- "$s"
}

__orb_report_cwd() {
  local url="file://${HOST:-localhost}"
  local encoded=${PWD//\%/%25}
  encoded=${encoded// /%20}
  __orb_osc "7;${url}${encoded}"
}

__orb_preexec() {
  typeset -g __orb_in_command=1
  __orb_osc "633;E;$(__orb_escape "$1")"
  __orb_osc "133;C"
}

__orb_mark_prompt_end() {
  # Zero-width OSC 133;B at the end of the prompt. Re-appended every precmd
  # because prompt frameworks (p10k, omz themes) may reassign PS1.
  local marker=$'%{\e]133;B\a%}'
  if [[ "$PS1" != *"$marker"* ]]; then
    PS1="$PS1$marker"
  fi
}

__orb_precmd() {
  local ec=$?
  if [[ -n "$__orb_in_command" ]]; then
    __orb_osc "133;D;$ec"
    typeset -g __orb_in_command=''
  elif [[ -n "$__orb_prompted" ]]; then
    # Prompt redrawn without a command (empty enter, ctrl-c): close without exit code.
    __orb_osc "133;D"
  fi
  __orb_report_cwd
  __orb_osc "133;A"
  __orb_mark_prompt_end
  typeset -g __orb_prompted=1
}

add-zsh-hook preexec __orb_preexec
add-zsh-hook precmd __orb_precmd
