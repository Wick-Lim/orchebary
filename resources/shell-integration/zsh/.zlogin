if [[ -f "$ORB_USER_ZDOTDIR/.zlogin" ]]; then
  ZDOTDIR=$ORB_USER_ZDOTDIR
  . "$ORB_USER_ZDOTDIR/.zlogin"
  ZDOTDIR=$ORB_ZDOTDIR
fi
