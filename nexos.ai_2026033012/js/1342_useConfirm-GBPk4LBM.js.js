
!function(){try{var e="undefined"!=typeof window?window:"undefined"!=typeof global?global:"undefined"!=typeof globalThis?globalThis:"undefined"!=typeof self?self:{},n=(new e.Error).stack;n&&(e._sentryDebugIds=e._sentryDebugIds||{},e._sentryDebugIds[n]="6363f98f-964d-5311-badf-b2128d81fa2e")}catch(e){}}();
(function(){try{var e=typeof window<`u`?window:typeof global<`u`?global:typeof globalThis<`u`?globalThis:typeof self<`u`?self:{};e.SENTRY_RELEASE={id:`77fbca36`}}catch{}})();import{n as e}from"./ConfirmModalContext-DhHAPwcx.js";var t=()=>{let{setModalState:t}=e();return{confirm:e=>new Promise(n=>{let r=()=>{e.onConfirm?.(),t(void 0),n(!0)},i=()=>{e.onCancel?.(),t(void 0),n(!1)};t({...e,isOpen:!0,onConfirm:r,onCancel:i})})}};export{t};
//# debugId=6363f98f-964d-5311-badf-b2128d81fa2e
